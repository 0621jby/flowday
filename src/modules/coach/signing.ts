import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { proposalSchema, type CoachProposal } from "./proposal";
export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function secret() {
  const key = process.env.AI_PROPOSAL_SECRET;
  if (key && key.length >= 32) return key;
  if (
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    (process.env.AI_PROVIDER && process.env.AI_PROVIDER !== "mock")
  )
    throw new Error("请配置至少32字符的 AI_PROPOSAL_SECRET。");
  return "flowday-local-mock-not-a-cloud-authority";
}
export function signProposal(actor: string, p: CoachProposal) {
  const payload = Buffer.from(JSON.stringify({ actor, proposal: p })).toString(
    "base64url",
  );
  return `${payload}.${createHmac("sha256", secret()).update(payload).digest("base64url")}`;
}
export function verifyProposal(actor: string, token: string) {
  if (token.length > 100000) throw new Error("建议签名无效。");
  const [body, signature, ...extra] = token.split(".");
  if (!body || !signature || extra.length) throw new Error("建议签名无效。");
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw new Error("建议已被修改，请重新生成。");
  const data = JSON.parse(Buffer.from(body, "base64url").toString());
  if (data.actor !== actor) throw new Error("建议不属于当前账户。");
  return proposalSchema.parse(data.proposal);
}
