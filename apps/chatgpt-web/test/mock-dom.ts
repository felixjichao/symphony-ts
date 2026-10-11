/**
 * Minimal simulated DOM for browser probe and adapter unit testing.
 */

export class MockElement {
  readonly tagName: string;
  readonly attributes: Map<string, string> = new Map();
  readonly classList: Set<string> = new Set();
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  value = "";
  textContent = "";
  disabled = false;
  className = "";
  id = "";
  style: Record<string, string> = {};
  private readonly eventListeners: Map<string, ((evt: { type: string }) => void)[]> = new Map();

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attributes)) {
      this.attributes.set(k, v);
      if (k === "class") {
        this.className = v;
        for (const cls of v.split(/\s+/)) {
          if (cls) this.classList.add(cls);
        }
      }
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") {
      this.className = value;
      this.classList.clear();
      for (const cls of value.split(/\s+/)) {
        if (cls) this.classList.add(cls);
      }
    }
  }

  appendChild(child: MockElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  addEventListener(type: string, listener: (evt: { type: string }) => void): void {
    const list = this.eventListeners.get(type) ?? [];
    list.push(listener);
    this.eventListeners.set(type, list);
  }

  dispatchEvent(evt: { type: string }): boolean {
    const list = this.eventListeners.get(evt.type) ?? [];
    for (const l of list) {
      l(evt);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  matches(selector: string): boolean {
    // Basic selector matching for test purposes
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      return this.id === id || this.attributes.get("id") === id;
    }
    if (selector.startsWith(".")) {
      const cls = selector.slice(1);
      return this.classList.has(cls);
    }
    const attrMatch = /\[([a-zA-Z0-9_-]+)([\^$*]?=)?['"]?([^'"]*)?['"]?\]/.exec(selector);
    if (attrMatch) {
      const attr = attrMatch[1]!;
      const op = attrMatch[2];
      const val = attrMatch[3];
      const actual = this.attributes.get(attr);
      if (actual === undefined || actual === null) return false;
      if (!op) return true;
      if (op === "=") return actual === val;
      if (op === "^=") return actual.startsWith(val!);
      if (op === "$=") return actual.endsWith(val!);
      if (op === "*=") return actual.includes(val!);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelector(selector: string): MockElement | null {
    const results = this.querySelectorAll(selector);
    return results[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const matched: MockElement[] = [];

    // Check comma-separated selectors
    if (selector.includes(",")) {
      const parts = selector.split(",").map((s) => s.trim());
      const matchingSets = parts.map((part) => new Set(this.querySelectorAll(part)));
      const ordered: MockElement[] = [];
      const traverse = (el: MockElement) => {
        if (matchingSets.some((set) => set.has(el))) {
          ordered.push(el);
        }
        for (const c of el.children) {
          traverse(c);
        }
      };
      for (const c of this.children) {
        traverse(c);
      }
      return ordered;
    }

    // Check space-separated descendant selectors
    const segments = selector.trim().split(/\s+/);
    if (segments.length > 1) {
      const first = segments[0]!;
      const rest = segments.slice(1).join(" ");
      const candidates: MockElement[] = [];
      const traverseFirst = (el: MockElement) => {
        if (el.matches(first)) candidates.push(el);
        for (const c of el.children) traverseFirst(c);
      };
      for (const c of this.children) traverseFirst(c);

      for (const cand of candidates) {
        matched.push(...cand.querySelectorAll(rest));
      }
      return matched;
    }

    const traverse = (el: MockElement) => {
      if (el.matches(selector)) {
        matched.push(el);
      }
      for (const c of el.children) {
        traverse(c);
      }
    };
    for (const c of this.children) {
      traverse(c);
    }
    return matched;
  }
}

export class MockDocument {
  readonly body: MockElement = new MockElement("body");

  querySelector(selector: string): MockElement | null {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): MockElement[] {
    return this.body.querySelectorAll(selector);
  }

  getElementById(id: string): MockElement | null {
    return this.querySelector(`#${id}`);
  }

  createElement(tagName: string): MockElement {
    return new MockElement(tagName);
  }
}

export class MockWindow {
  location = {
    href: "https://chatgpt.com",
    origin: "https://chatgpt.com",
    assign(url: string) {
      this.href = url;
    },
  };
}
