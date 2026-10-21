import { STORAGE_MANAGE_URL } from "@tinycloud/sdk-core";
import type { HostContext, PanelClient, PanelSection } from "../slots";
import { text } from "../strings";
import {
  afterAuthority,
  reduceStorage,
  storageModel,
  type StorageModel,
  type StorageRead,
  type StorageResult,
  type StorageViewState,
} from "../storage-state";

/**
 * Only the bar needs CSS of its own. Text uses the panel's `busy`, `note` and `action` classes.
 * Track is the light control border `#6b7280` from styles.ts (`.button`, `.action`): 4.83:1 on white (WCAG 1.4.11).
 * Dark keeps the light track, which measures 14.73:1 on the dark panel.
 */
const STYLE = `
.storage-bar{height:6px;margin:6px 0 8px;border-radius:3px;background:#6b7280;overflow:hidden}
.storage-bar>span{display:block;height:100%;background:#111827}
@media (prefers-color-scheme: dark){.storage-bar{background:#e5e7eb}}
`;

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** Decimal units, as storage quotas are usually quoted. Unit names come from Intl, not copy. */
function formatBytes(bytes: number): string {
  let unit = 0;
  let value = bytes;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: UNITS[unit],
    maximumFractionDigits: 1,
  }).format(value);
}

/** The SDK `Result` is `{data}` / `{error.code}`; the reducer reads `{value}` / `{code}`. */
async function readStatus(client: PanelClient): Promise<StorageResult> {
  try {
    const result = await client.storage.status();
    if ("error" in result) return { ok: false, code: result.error.code };
    return { ok: true, value: result.data };
  } catch {
    return { ok: false, code: "unknown" };
  }
}

/** The `manageUrl` from the last good status, if it is https. The constant otherwise. */
function manageHref(read: StorageRead): string {
  if (!read.signedIn || read.result === undefined || !read.result.ok) return STORAGE_MANAGE_URL;
  const value: unknown = read.result.value;
  if (typeof value !== "object" || value === null || !("manageUrl" in value)) return STORAGE_MANAGE_URL;
  const url: unknown = value.manageUrl;
  if (typeof url !== "string") return STORAGE_MANAGE_URL;
  try {
    return new URL(url).protocol === "https:" ? url : STORAGE_MANAGE_URL;
  } catch {
    return STORAGE_MANAGE_URL;
  }
}

/**
 * Storage usage against `tc.storage`. Mounted only while the panel is open.
 * Numbers render only for `known` and `unlimited`; every other state renders words.
 * The own-storage episode is read at mount and on every change, so no state is missed.
 */
export const storageSection: PanelSection = {
  id: "storage",
  isAvailable: (ctx) => ctx.client()?.signedIn() === true,
  mount(el, ctx: HostContext) {
    const client = ctx.client();
    if (!client || !client.signedIn()) return () => undefined;

    let disposed = false;
    let busy = false;
    let seq = 0;
    let read: StorageRead = { signedIn: true };
    // `view` is `reduceStorage(read)` except after an authority outcome, which overrides it.
    let view: StorageViewState = reduceStorage(read);

    const style = document.createElement("style");
    style.textContent = STYLE;

    const word = document.createElement("p");
    word.className = "busy";
    const usage = document.createElement("p");
    usage.className = "busy";
    const bar = document.createElement("div");
    bar.className = "storage-bar";
    const fill = document.createElement("span");
    bar.append(fill);
    const note = document.createElement("p");
    note.className = "note";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "action";
    const manage = document.createElement("a");
    manage.className = "action";
    manage.target = "_blank";
    manage.rel = "noopener noreferrer";
    manage.textContent = ctx.text("storage.manage");

    function usageText(model: StorageModel): string {
      const usageView = model.usage;
      if (usageView === undefined) return "";
      const template = ctx.text(usageView.key);
      const used = formatBytes(usageView.usedBytes);
      if (usageView.limitBytes === undefined) return template.replace("{used}", used);
      return template.replace("{used}", used).replace("{limit}", formatBytes(usageView.limitBytes));
    }

    function render(): void {
      if (disposed) return;
      const episodeOn = client?.storageEpisode?.current() !== undefined;
      const model = storageModel(view, episodeOn);

      word.hidden = model.wordKey === undefined;
      word.textContent = model.wordKey === undefined ? "" : ctx.text(model.wordKey);

      usage.hidden = model.usage === undefined;
      usage.textContent = usageText(model);
      const percent = model.usage?.percent;
      bar.hidden = percent === undefined;
      fill.style.width = percent === undefined ? "0%" : `${percent}%`;

      note.hidden = model.noteKey === undefined;
      note.textContent = model.noteKey === undefined ? "" : ctx.text(model.noteKey);

      action.hidden = model.action === undefined;
      action.disabled = busy;
      action.textContent =
        model.action === undefined
          ? ""
          : ctx.text(
              model.action === "allow"
                ? "storage.allow"
                : model.action === "try_again"
                  ? "storage.try_again"
                  : "storage.retry",
            );

      manage.href = manageHref(read);
    }

    async function load(): Promise<void> {
      const token = ++seq;
      busy = true;
      // A refetch keeps the previous result on screen; `loading` shows only with none.
      read = { signedIn: true, result: read.signedIn ? read.result : undefined };
      view = reduceStorage(read);
      render();
      const result = await readStatus(client);
      busy = false;
      if (disposed || token !== seq) return;
      read = { signedIn: true, result };
      view = reduceStorage(read);
      render();
    }

    async function askAuthority(): Promise<void> {
      if (busy) return;
      busy = true;
      render();
      let outcome: { approved: boolean; code?: string };
      try {
        outcome = client.requestAuthority
          ? await client.requestAuthority("space/info")
          : { approved: false, code: "unsupported" };
      } catch {
        outcome = { approved: false, code: "unknown" };
      }
      busy = false;
      if (disposed) return;
      if (outcome.approved) {
        void load();
        return;
      }
      view = afterAuthority(outcome);
      render();
    }

    action.addEventListener("click", (event) => {
      if (!event.isTrusted || busy) return;
      if (view.kind === "error") {
        void load();
        return;
      }
      void askAuthority();
    });

    const unsubscribe = client.storageEpisode?.subscribe(() => {
      void load();
    });

    el.append(style, word, usage, bar, note, action, manage);
    void load();

    return () => {
      disposed = true;
      unsubscribe?.();
      el.replaceChildren();
    };
  },
};
