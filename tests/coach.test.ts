import { it, expect } from "vitest";
import { recoverySuggestion } from "../src/modules/coach/coach";
it("provides bounded next steps without claiming AI or changing source tasks", () => {
  expect(recoverySuggestion("写项目", "large").minutes).toBe(10);
  expect(recoverySuggestion("写项目", "unclear").step).toContain("完成标准");
  expect(recoverySuggestion("写项目", "tired").minutes).toBe(5);
});
