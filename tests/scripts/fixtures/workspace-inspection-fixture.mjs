import { readFileSync } from "node:fs";

export function workspaceInspectionFixture(root, mode = "complete") {
  const value = JSON.parse(readFileSync(new URL(`./workspace-inspection-${mode === "incomplete" ? "incomplete" : "complete"}.json`, import.meta.url), "utf8"));
  value.workspace.root = root;
  if (mode === "empty") value.applications = [];
  if (mode === "unknown-schema") value.schema = "ailoha.workspace.inspection/v2";
  if (mode === "xss") {
    const payload = '<img src=x onerror="window.workspaceXss=true">';
    value.applications[0].nativeTarget.name = payload;
    value.applications[0].evidence[0].observation = payload;
    value.diagnostics[0].message = payload;
    value.diagnostics[0].path = `relative/${payload}.json`;
  }
  return value;
}
