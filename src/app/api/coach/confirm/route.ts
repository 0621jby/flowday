import { coachFailure, coachSession } from "@/modules/coach/server";
import { verifyProposal } from "@/modules/coach/signing";
import { compileProposal } from "@/modules/coach/proposal";
import { failure, HttpError, json, readJson, sameOrigin } from "@/lib/http";
import { workspaceDelta } from "@/modules/cloud/delta";

// Only validates the explicit confirmation. Persistence remains in the existing
// workspace use case / /api/workspace transaction; the model has no writer.
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = (await readJson(request)) as {
      token?: unknown;
      state?: unknown;
    };
    if (typeof body?.token !== "string")
      throw new HttpError(400, "缺少建议确认凭据。");
    const session = await coachSession(request, body.state);
    const proposal = verifyProposal(session.actor, body.token);
    const preview = compileProposal(session.state, proposal);
    return json({
      changes: workspaceDelta(session.state, preview.state),
      impact: preview.impact,
      revision: proposal.revision,
    });
  } catch (e) {
    try {
      coachFailure(e);
    } catch (safe) {
      return failure(safe);
    }
  }
}
