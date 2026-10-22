/**
 * Body scroll lock shared by the prompt modals. Each acquire holds one count and
 * the body is unlocked only when the last holder releases. A release runs at most
 * once per acquire, so a displaced modal's delayed hide cannot clear the lock that
 * the prompt replacing it still holds.
 */
let holders = 0;
// The page's own body overflow, captured when the first holder acquires. Restored
// on the last release, so a page that already used `overflow: clip` keeps it.
let savedOverflow = "";

export function acquireScrollLock(): () => void {
  let held = true;
  if (holders === 0) savedOverflow = document.body.style.overflow;
  holders += 1;
  document.body.style.overflow = "hidden";
  return () => {
    if (!held) return;
    held = false;
    holders -= 1;
    if (holders === 0) document.body.style.overflow = savedOverflow;
  };
}
