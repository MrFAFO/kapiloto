import { parse } from "parse5";

/**
 * The only module that parses HTML (parse5). It turns a fetched page into the
 * facts verification needs: deterministic visible text, the title, JSON-LD
 * blocks, meta tags and machine-readable time elements, each with a stable
 * location string for audit. It never executes or follows anything.
 */

type Attr = { name: string; value: string };
type Node = { nodeName: string; tagName?: string; attrs?: Attr[]; childNodes?: Node[]; value?: string; content?: Node };

export type ExtractedMeta = { key: string; content: string; location: string };
export type ExtractedTime = { datetime: string; itemprop: string | null; pubdate: boolean; location: string };
export type ExtractedJsonLd = { index: number; value: unknown | null; parseError: boolean };

export type ExtractedHtml = {
  title: string | null;
  canonicalUrl: string | null;
  /** Visible text: blocks separated by "\n", inline whitespace collapsed. */
  text: string;
  jsonLd: ExtractedJsonLd[];
  metas: ExtractedMeta[];
  times: ExtractedTime[];
};

const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "head", "select", "button"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
  "td", "th", "thead", "tr", "ul", "body", "html",
]);

const attr = (node: Node, name: string): string | null => node.attrs?.find((item) => item.name === name)?.value ?? null;

function childrenOf(node: Node): Node[] {
  return node.nodeName === "template" ? (node.content?.childNodes ?? []) : (node.childNodes ?? []);
}

function textContent(node: Node): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return childrenOf(node).map(textContent).join("");
}

function visibleText(root: Node): string {
  const blocks: string[] = [];
  let current = "";
  const flush = () => {
    const line = current.replace(/\s+/g, " ").trim();
    if (line) blocks.push(line);
    current = "";
  };
  const walk = (node: Node) => {
    if (node.nodeName === "#text") {
      current += node.value ?? "";
      return;
    }
    if (node.nodeName.startsWith("#") && node.nodeName !== "#document" && node.nodeName !== "#document-fragment") return;
    const tag = node.tagName ?? "";
    if (SKIPPED.has(tag) || attr(node, "hidden") != null || attr(node, "aria-hidden") === "true") return;
    const block = BLOCK.has(tag);
    if (block) flush();
    for (const child of childrenOf(node)) walk(child);
    if (block) flush();
  };
  walk(root);
  flush();
  return blocks.join("\n");
}

/** Parses one HTML document. Pure and deterministic for a given input string. */
export function extractHtml(html: string): ExtractedHtml {
  const document = parse(html) as unknown as Node;
  let title: string | null = null;
  let canonicalUrl: string | null = null;
  const jsonLd: ExtractedJsonLd[] = [];
  const metas: ExtractedMeta[] = [];
  const times: ExtractedTime[] = [];
  const metaCounts = new Map<string, number>();
  let timeIndex = 0;

  const walk = (node: Node) => {
    const tag = node.tagName;
    if (tag === "title" && title == null) title = textContent(node).replace(/\s+/g, " ").trim() || null;
    if (tag === "link" && canonicalUrl == null && (attr(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      canonicalUrl = attr(node, "href");
    }
    if (tag === "script" && (attr(node, "type") ?? "").trim().toLowerCase() === "application/ld+json") {
      const raw = textContent(node).trim();
      try {
        jsonLd.push({ index: jsonLd.length, value: JSON.parse(raw), parseError: false });
      } catch {
        jsonLd.push({ index: jsonLd.length, value: null, parseError: true });
      }
    }
    if (tag === "meta") {
      const key = (attr(node, "property") ?? attr(node, "name") ?? attr(node, "itemprop") ?? "").trim().toLowerCase();
      const content = attr(node, "content");
      if (key && content != null) {
        const seen = metaCounts.get(key) ?? 0;
        metaCounts.set(key, seen + 1);
        metas.push({ key, content: content.trim(), location: `meta[${key}]#${seen}` });
      }
    }
    if (tag === "time") {
      const datetime = attr(node, "datetime");
      if (datetime != null) {
        const itemprop = attr(node, "itemprop");
        times.push({ datetime: datetime.trim(), itemprop: itemprop?.trim() ?? null, pubdate: attr(node, "pubdate") != null, location: `time#${timeIndex}` });
      }
      timeIndex += 1;
    }
    for (const child of childrenOf(node)) walk(child);
  };
  walk(document);

  return { title, canonicalUrl, text: visibleText(document), jsonLd, metas, times };
}
