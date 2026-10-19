import { expect, test } from "@playwright/test";

/** The acceptance test: the whole judge demo, through the real UI and API. */
test("bearing-wear incident: detect → diagnose → auto-reroute → approval → closed → verified", async ({ page }) => {
  await page.goto("/#/line");
  await expect(page.getByText("Line 02 · Machining")).toBeVisible();
  await page.getByTestId("start-demo").click();

  // The line agent opens an incident and the guard escalates the work order.
  await page.getByRole("link", { name: /Approvals/ }).click();
  const card = page.locator('[data-testid^="approval-"]').first();
  await expect(card).toContainText("needs Maintenance lead", { timeout: 60_000 });
  await expect(card).toContainText("Switch to");

  // Operator cannot approve; the maintenance lead can.
  await page.getByTestId("acting-as").selectOption("maintenance_lead");
  await card.getByRole("textbox").fill("Spare bearing in stores");
  await card.getByRole("button", { name: /Approve as Maintenance lead/ }).click();
  await expect(card).toContainText("approved", { timeout: 20_000 });

  // Incident closes with downtime avoided; the batch was rerouted automatically.
  await page.getByRole("link", { name: /^Incidents/ }).click();
  await expect(page.locator("table.t")).toContainText("closed", { timeout: 30_000 });
  await page.locator("table.t a").first().click();
  const timeline = page.getByTestId("timeline");
  for (const step of ["Detected", "Failure forecast", "Root cause", "Recommendation", "Policy guard", "Executed", "Closed with summary"]) await expect(timeline).toContainText(step);
  await expect(page.getByText(/min downtime avoided/)).toBeVisible();

  // Verification passes, and simulated tampering is caught.
  await page.getByRole("link", { name: "Verify audit trail" }).click();
  await expect(page.getByTestId("verify-overall")).toHaveText("✔ Verified", { timeout: 20_000 });
  await page.locator('[data-testid^="tamper-"]').nth(2).click();
  await expect(page.getByTestId("verify-overall")).toHaveText("✘ Failed");
});
