import { coachInputSchema } from "@/modules/coach/schema";
import { coachFailure, coachSession } from "@/modules/coach/server";
import {
  createProvider,
  PROMPT_VERSION,
  providerConfig,
} from "@/modules/coach/provider";
import { applyCoachGrowth, buildCoachContext } from "@/modules/coach/context";
import { compileProposal, makeProposal } from "@/modules/coach/proposal";
import { hash, signProposal, verifyProposal } from "@/modules/coach/signing";
import { finish, reserve } from "@/modules/coach/limits";
import { failure, HttpError, json, readJson, sameOrigin } from "@/lib/http";
import { ModelCallError } from "@/modules/coach/completion-provider";

export async function GET() {
  try {
    const c = providerConfig();
    return json({ mode: c.mode, model: c.model, ready: true });
  } catch {
    return json({ mode: "unavailable", ready: false });
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const raw = await readJson(request);
    const body = raw as { input?: unknown; state?: unknown };
    const parsed = coachInputSchema.safeParse(body?.input);
    if (!parsed.success)
      throw new HttpError(400, "请填写具体情况，输入上限1200字。");
    const input = parsed.data;
    const session = await coachSession(request, body.state, input);
    const context = buildCoachContext(session.state, input, !session.client);
    if (session.client || context.growth)
      applyCoachGrowth(
        context,
        session.client ? session.growth : context.growth,
      );
    const provider = createProvider();
    while (JSON.stringify(context).length > 14000 && context.tasks.length > 1)
      context.tasks.pop();
    context.blocks = context.blocks.filter((b) =>
      context.tasks.some((t) => t.id === b.taskId),
    );
    const requestHash = hash({
      actor: session.actor,
      revision: session.state.revision,
      input,
      context: { ...context, nowMinute: undefined, planLoad: undefined },
      prompt: PROMPT_VERSION,
      provider: provider.name,
      model: provider.model,
    });
    const reservation = await reserve(
      session,
      requestHash,
      provider.name,
      provider.model,
    );
    if (reservation.cached) {
      const cached = reservation.cached as { token: string };
      const proposal = verifyProposal(session.actor, cached.token);
      compileProposal(session.state, proposal);
      return json({ ...(reservation.cached as object), cached: true });
    }
    let usage = null;
    try {
      const result = await provider.generate(input, context);
      usage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        providerCalls: result.providerCalls,
      };
      const proposal = makeProposal(session.state, input, result.advice);
      const preview = compileProposal(session.state, proposal);
      const response = {
        proposal,
        token: signProposal(session.actor, proposal),
        impact: preview.impact,
        hasChanges: preview.hasChanges,
        profile: context.profile,
        mode: provider.name,
        model: provider.model,
        usage,
        cached: false,
      };
      await finish(session, reservation.id, response, usage);
      return json(response);
    } catch (e) {
      if (e instanceof ModelCallError) usage = e.usage;
      await finish(session, reservation.id, null, usage).catch(() => {});
      throw e;
    }
  } catch (e) {
    try {
      coachFailure(e);
    } catch (safe) {
      return failure(safe);
    }
  }
}
