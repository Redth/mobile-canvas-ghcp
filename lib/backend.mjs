export function mobileCanvasBackend(value = process.env.MOBILE_CANVAS_BACKEND) {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "ailoha") return "ailoha";
  throw new Error("MOBILE_CANVAS_BACKEND must be legacy or ailoha. Ailoha opt-in never falls back to legacy.");
}
