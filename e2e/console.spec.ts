import { expect, test, type Page } from "@playwright/test";
import { injectWallet } from "./wallet";

/**
 * The whole product through the real UI: wallet sign-in, site setup, a real (manual) data source,
 * a pipeline built in the builder, a run driven by the asset's part counter, a gate released with
 * an EIP-712 signature, and a verified ledger. No sample data anywhere.
 */
test.describe.configure({ mode: "serial" });

const choose = async (page: Page, trigger: ReturnType<Page["locator"]>, option: string | RegExp) => {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
};

const shotDir = process.env.E2E_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: true });
};

test("sign in, set up a site, build, run, sign a gate, verify", async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const wallet = await injectWallet(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in with your wallet" })).toBeVisible();
  await shot(page, "01-sign-in");
  await page.getByRole("button", { name: /Test Wallet/ }).click();

  // ---- Setup ----
  await expect(page.getByRole("heading", { name: "Create your site" })).toBeVisible();
  await page.getByPlaceholder("e.g. Pune Plant 1").fill("Pune Plant 1");
  await page.getByRole("button", { name: "Create site" }).click();

  // ---- Floor: register a manual asset with a temperature limit ----
  await expect(page.getByRole("heading", { name: "Floor & fleet" })).toBeVisible();
  await expect(page.getByText("No assets registered")).toBeVisible();
  await page.getByRole("button", { name: "Add asset" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("e.g. CNC-05").fill("CNC-01");
  await dialog.getByRole("radio", { name: "Manual readings" }).click();
  const limitRow = dialog.locator("tbody tr").first();
  await limitRow.locator("input").nth(0).fill("60");
  await limitRow.locator("input").nth(1).fill("80");
  await dialog.getByRole("button", { name: "Register" }).click();
  await expect(page.locator("table.t")).toContainText("CNC-01");
  await expect(page.locator("table.t")).toContainText("No data yet");

  const approve = async (code: string) => {
    await page.locator(".block").getByRole("button", { name: "Approve" }).click();
    const sig = page.getByRole("dialog", { name: new RegExp(`Approve ${code}`) });
    await expect(sig).toContainText("inbox.decide");
    await expect(sig).toContainText(wallet.address.slice(0, 6));
    await sig.getByRole("button", { name: "Sign with wallet" }).click();
    await expect(sig).toBeHidden({ timeout: 15_000 });
  };
  const reading = async (signal: RegExp, value: string) => {
    await page.locator("table.t tr.click", { hasText: "CNC-01" }).click();
    await page.getByRole("button", { name: "Record a reading" }).click();
    const m = page.getByRole("dialog", { name: "Record a reading" });
    await choose(page, m.locator(".sel-btn").first(), signal);
    if (/execution/.test(String(signal))) await choose(page, m.locator(".sel-btn").nth(1), "ACTIVE");
    else await m.locator("input.input").fill(value);
    await m.getByRole("button", { name: "Record" }).click();
    await expect(m).toBeHidden();
    await page.keyboard.press("Escape");
  };
  await reading(/^execution$/, "ACTIVE");
  await reading(/^part count$/, "100");
  await expect(page.locator("table.t")).toContainText("Running");
  await shot(page, "02-floor");

  // ---- Only validators release quality gates: the admin applies as one and approves it with a signature ----
  await page.getByRole("link", { name: /Team & validators/ }).click();
  await page.getByRole("tab", { name: /Validators/ }).click();
  await expect(page.getByText("Stakes are off.")).toBeVisible();
  await page.getByRole("button", { name: "Apply as validator" }).click();
  const ap = page.getByRole("dialog", { name: "Apply as a validator" });
  await ap.getByRole("textbox", { name: "Full name" }).fill("Aloys Jehwin");
  await ap.getByRole("textbox", { name: "Qualifications" }).fill("ISO 9001 internal auditor, 4 years in machining QA");
  await ap.getByRole("button", { name: "Send application" }).click();
  await expect(ap).toBeHidden();
  await page.getByRole("tab", { name: /Applications/ }).click();
  await expect(page.locator(".app-card")).toContainText("Validator · Quality engineer");
  await shot(page, "11-applications");
  await page.getByRole("button", { name: "Approve and sign" }).click();
  const grant = page.getByRole("dialog", { name: /Approve Aloys Jehwin/ });
  await expect(grant).toContainText("role.grant");
  await grant.getByRole("button", { name: "Sign with wallet" }).click();
  await expect(grant).toBeHidden({ timeout: 15_000 });
  await page.getByRole("tab", { name: /Validators/ }).click();
  await expect(page.locator("table.t")).toContainText("Can sign");
  await shot(page, "12-validators");

  // ---- Builder: publish a 3-stage pipeline ----
  await page.getByRole("link", { name: "Builder" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline builder" })).toBeVisible();
  await page.getByRole("button", { name: /\+ Order intake/ }).click();
  await page.getByRole("button", { name: /\+ Machining/ }).click();
  await page.getByRole("button", { name: /\+ Quality inspection/ }).click();
  await expect(page.locator(".b-card")).toHaveCount(3);
  await page.locator(".b-card").nth(1).click();
  await shot(page, "03-builder");
  await page.locator(".builder input.input").first().fill("Housing line");
  await page.getByRole("button", { name: "Publish pipeline" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published Housing line v1/)).toBeVisible();

  // ---- Start a run ----
  await page.getByRole("link", { name: "Pipelines" }).click();
  await page.getByRole("button", { name: "Start a run" }).click();
  const start = page.getByRole("dialog", { name: "Start a pipeline run" });
  await choose(page, start.locator(".sel-btn").first(), /Housing line/);
  await start.getByPlaceholder("e.g. SO-48213").fill("SO-7781");
  await start.locator('input[type="number"]').fill("5");
  await start.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Housing line" })).toBeVisible();
  await expect(page.locator(".node-hit", { hasText: "02" })).toContainText(/Running/);

  // ---- The machine counts 5 parts: stage 02 completes from measured data ----
  await page.getByRole("link", { name: "Floor & fleet" }).click();
  await reading(/^part count$/, "105");
  await page.getByRole("link", { name: "Pipelines" }).click();
  // OEE cannot be measured without an ideal cycle time, so the stage waits for a person to confirm.
  await expect(page.locator(".node-hit", { hasText: "02" })).toContainText("Awaiting approval", { timeout: 30_000 });
  await page.locator(".node-hit", { hasText: "02" }).click();
  await expect(page.locator(".block")).toContainText("Not measured: OEE");
  await shot(page, "04-pipeline-gate");
  await approve("02");
  await expect(page.locator(".node-hit", { hasText: "02" })).toContainText("Completed", { timeout: 20_000 });

  // ---- Operator records the inspection; approve mode raises a gate ----
  await page.locator(".node-hit", { hasText: "03" }).click();
  await page.locator(".block").getByRole("button", { name: "Record units" }).click();
  const rec = page.getByRole("dialog", { name: /Record/ });
  await rec.locator('input[type="number"]').first().fill("5");
  await rec.getByRole("button", { name: "Record" }).click();
  await expect(page.locator(".node-hit", { hasText: "03" })).toContainText("Awaiting approval", { timeout: 20_000 });

  // ---- Release the gate with an EIP-712 signature (its block is still open) ----
  await expect(page.locator(".block")).toContainText("Awaiting approval");
  await approve("03");
  await expect(page.locator(".main .ph-text .eyebrow")).toContainText("completed", { timeout: 20_000 });
  await expect(page.locator(".stream")).toContainText("Approve 03");
  await page.keyboard.press("Escape");
  await shot(page, "05-pipeline-done");
  await page.getByRole("link", { name: "Approvals" }).click();
  await page.getByRole("radio", { name: "All" }).click();
  await shot(page, "06-approvals");
  await page.getByRole("link", { name: "Templates" }).click();
  await shot(page, "07-templates");
  await page.getByRole("link", { name: "Validation" }).click();
  await page.getByRole("button", { name: "New validation package" }).click();
  const np = page.getByRole("dialog", { name: "New validation package" });
  await choose(page, np.getByRole("group", { name: "Run" }).locator(".sel-btn"), /Housing line/);
  await choose(page, np.getByRole("group", { name: "Stage" }).locator(".sel-btn"), /02 · Machining/);
  await np.getByRole("button", { name: "Create draft" }).click();
  await page.getByRole("button", { name: "Run agent pre-check" }).click();
  await expect(page.getByText("Agent assessment")).toBeVisible();
  await shot(page, "08-validation");

  // ---- Run history shows it; the ledger verifies ----
  await page.getByRole("link", { name: "Run history" }).click();
  await expect(page.locator("table.t")).toContainText("SO-7781");
  await page.getByRole("link", { name: "Proof & ledger" }).click();
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText("Ledger verified.")).toBeVisible();
  await shot(page, "09-proof");
  await page.getByRole("link", { name: "Run history" }).click();
  await page.locator(".date .sel-btn").click();
  await shot(page, "10-history-calendar");
});
