import { expect, test } from "@playwright/test";
import { board, boardScenario, openApp, png, promptNode, edge, taskNode, task } from "../app";

test("应用在假壳下启动并渲染画板", async ({ page }) => {
  const text = board("冒烟", [promptNode("p1", "一只猫"), taskNode("t1")], [edge("p1", "t1", "positive")]);
  const errors = await openApp(page, boardScenario("冒烟", text));
  await expect(task(page, "t1")).toBeVisible();
  await page.screenshot({ path: "test-results/smoke.png" });
  expect(errors).toEqual([]);
  void png;
});
