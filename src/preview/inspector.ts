import type { CompositionDiagnostic } from "../contracts.js";

export interface InspectorRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface InspectorSection {
  title: string;
  rows: readonly InspectorRow[];
}

export interface InspectorActions {
  jumpStart?: () => void;
  jumpEnd?: () => void;
  copyText?: string;
  sourceHref?: string;
}

export interface InspectorModel {
  kind: "element" | "clip";
  title: string;
  subtitle?: string;
  sections: readonly InspectorSection[];
  diagnostics: readonly CompositionDiagnostic[];
  actions?: InspectorActions;
}

export interface Inspector {
  show(model: InspectorModel): void;
  hide(): void;
  isOpen(): boolean;
}

export interface InspectorOptions {
  /** When set, the inspector renders inline inside this element instead of floating over the page. */
  container?: HTMLElement;
  onVisibilityChange?: (open: boolean) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function diagnosticHref(diagnostic: CompositionDiagnostic, fallback?: string): string | undefined {
  const path = diagnostic.details?.path;
  if (path === undefined) {
    return fallback;
  }
  const url = new URL(path, window.location.origin);
  const line = diagnostic.details?.line;
  return line !== undefined ? `${url.href}#L${line}` : url.href;
}

function formatDiagnostic(diagnostic: CompositionDiagnostic): string {
  const line = diagnostic.details?.line;
  const column = diagnostic.details?.column;
  const location =
    line !== undefined
      ? ` · ${diagnostic.details?.path ?? "source"}:${line}${column !== undefined ? `:${column}` : ""}`
      : "";
  return `${diagnostic.severity}: [${diagnostic.code}] ${diagnostic.message}${location}`;
}

/**
 * Creates the read-only preview inspector. It only reads preview state and
 * never mutates the composition or timeline.
 */
export function createInspector(options: InspectorOptions = {}): Inspector {
  const root = element("aside", "inspector");
  root.id = "inspector";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Inspector");
  root.setAttribute("aria-live", "polite");
  if (options.container !== undefined) {
    root.classList.add("docked");
  }

  const head = element("div", "inspector-head");
  const eyebrow = element("span", "eyebrow", "inspector");
  const close = element("button", "inspector-close", "×");
  close.id = "inspector-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close inspector");
  head.append(eyebrow, close);

  const title = element("h2", "inspector-title");
  title.id = "inspector-title";
  const subtitle = element("p", "inspector-subtitle");
  subtitle.id = "inspector-subtitle";
  const content = element("div", "inspector-content");
  content.id = "inspector-content";
  const actions = element("div", "inspector-actions");
  actions.id = "inspector-actions";
  const diagnostics = element("div", "inspector-diagnostics");
  diagnostics.id = "inspector-diagnostics";
  const status = element("p", "inspector-status");
  status.id = "inspector-status";
  status.setAttribute("aria-live", "polite");

  root.append(head, title, subtitle, content, actions, diagnostics, status);
  (options.container ?? document.body).append(root);

  let copyButton: HTMLButtonElement | null = null;

  const hide = (): void => {
    if (root.hidden) {
      return;
    }
    root.hidden = true;
    copyButton = null;
    options.onVisibilityChange?.(false);
  };

  close.addEventListener("click", hide);

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !root.hidden) {
        event.preventDefault();
        hide();
      }
    },
    true,
  );

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    if (copyButton) {
      copyButton.dataset.copied = "true";
    }
    status.textContent = "Copied still command.";
  };

  return {
    show(model: InspectorModel): void {
      const wasHidden = root.hidden;
      root.hidden = false;
      if (wasHidden) {
        options.onVisibilityChange?.(true);
      }
      root.dataset.kind = model.kind;
      title.textContent = model.title;
      subtitle.textContent = model.subtitle ?? "";
      subtitle.hidden = (model.subtitle ?? "").length === 0;
      content.replaceChildren();

      for (const section of model.sections) {
        const group = element("section", "inspector-section");
        group.append(element("h3", undefined, section.title));
        for (const row of section.rows) {
          const line = element("div", "inspector-row");
          line.dataset.label = row.label;
          const label = element("span", "inspector-label", row.label);
          const value = element("code", "inspector-value", row.value);
          if (row.mono !== false) {
            value.classList.add("mono");
          }
          line.append(label, value);
          group.append(line);
        }
        content.append(group);
      }

      actions.replaceChildren();
      const actionList = model.actions;
      const addAction = (id: string, labelText: string, handler: () => void, disabled = false): void => {
        const button = element("button", "ghost small", labelText);
        button.id = id;
        button.type = "button";
        button.disabled = disabled;
        button.addEventListener("click", handler);
        actions.append(button);
      };
      addAction(
        "inspector-jump-start",
        "jump to start",
        () => actionList?.jumpStart?.(),
        actionList?.jumpStart === undefined,
      );
      addAction("inspector-jump-end", "jump to end", () => actionList?.jumpEnd?.(), actionList?.jumpEnd === undefined);

      copyButton = element("button", "ghost small", "copy still command");
      copyButton.id = "inspector-copy";
      copyButton.type = "button";
      copyButton.disabled = actionList?.copyText === undefined;
      if (actionList?.copyText !== undefined) {
        copyButton.dataset.copyText = actionList.copyText;
        copyButton.addEventListener("click", () => void copy(actionList.copyText as string));
      }
      actions.append(copyButton);

      const source = element("a", "ghost small", "open source");
      source.id = "inspector-open";
      source.target = "_blank";
      source.rel = "noopener";
      if (actionList?.sourceHref !== undefined) {
        source.href = actionList.sourceHref;
      } else {
        source.setAttribute("aria-disabled", "true");
        source.hidden = true;
      }
      actions.append(source);

      diagnostics.replaceChildren();
      if (model.diagnostics.length === 0) {
        diagnostics.hidden = true;
      } else {
        diagnostics.hidden = false;
        for (const diagnostic of model.diagnostics) {
          const line = element("div", `inspector-diagnostic ${diagnostic.severity}`);
          const href = diagnosticHref(diagnostic, actionList?.sourceHref);
          if (href === undefined) {
            line.textContent = formatDiagnostic(diagnostic);
          } else {
            const link = element("a", undefined, formatDiagnostic(diagnostic));
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener";
            link.title = "Open source location";
            line.append(link);
          }
          diagnostics.append(line);
        }
      }

      status.textContent = "";
      if (wasHidden) {
        close.focus({ preventScroll: true });
      }
    },

    hide,

    isOpen(): boolean {
      return !root.hidden;
    },
  };
}
