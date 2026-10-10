export function createCanvas(options) {
  return {
    declaration: {
      id: options.id, displayName: options.displayName, description: options.description,
      inputSchema: options.inputSchema,
      actions: options.actions.map(({ handler, ...metadata }) => metadata),
    },
    ...options,
  };
}
export async function joinSession(options) {
  globalThis.ailohaTestCanvasRegistration = options;
}
