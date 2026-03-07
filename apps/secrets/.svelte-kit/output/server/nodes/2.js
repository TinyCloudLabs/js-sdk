

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export const imports = ["_app/immutable/nodes/2.CO0gHTXM.js","_app/immutable/chunks/DB9b5SQb.js","_app/immutable/chunks/DUKrAqtd.js"];
export const stylesheets = [];
export const fonts = [];
