#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

export type CopyIssue = {
  code: string;
  message: string;
  text?: string;
};

const normalize = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() ?? "";
const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
const headingVerb = /\b(?:am|is|are|was|were|becomes?|keeps?|holds?|owns?|points?|joins?|encodes?|binds?|stores?|routes?|sends?|returns?|applies?|creates?|makes?|changes?|prevents?|allows?|rejects?|accepts?|validates?|performs?|runs?|drives?|exposes?|carries?|connects?|combines?|records?|reconstructs?|materializes?|allocates?|coalesces?|retries?|projects?|wins?|means?|follows?)\b/i;

function isHidden(element: Element): boolean {
  return Boolean(element.closest("[aria-hidden='true']"));
}

export function lintVisibleCopy(html: string): CopyIssue[] {
  const { document } = parseHTML(html);
  document.querySelectorAll("script, style, template, noscript").forEach((element) => element.remove());

  const issues: CopyIssue[] = [];
  const blocks = [...document.querySelectorAll("h1, h2, h3, p, figcaption")].filter((element) => !isHidden(element));
  const headings = [...document.querySelectorAll("h1, h2, h3")].filter((element) => !isHidden(element));
  const h1s = headings.filter((element) => element.localName === "h1");

  if (h1s.length !== 1) {
    issues.push({ code: "title-count", message: `Expected one visible h1; found ${h1s.length}.` });
  }

  const title = h1s[0];
  if (title) {
    const text = normalize(title.textContent);
    if (words(text) > 6) issues.push({ code: "title-length", message: "Title should identify the subject in six words or fewer.", text });
    if (/[:;.!?]/.test(text)) issues.push({ code: "title-thesis", message: "Title should identify the subject rather than state a thesis.", text });
    const documentTitle = normalize(document.querySelector("title")?.textContent);
    if (!documentTitle || documentTitle.toLowerCase() !== text.toLowerCase()) {
      issues.push({ code: "document-title", message: "Make the HTML document title match the visible h1.", text: documentTitle || undefined });
    }

    const titleIndex = blocks.indexOf(title);
    if (titleIndex > 0) {
      const preface = normalize(blocks[0].textContent);
      issues.push({ code: "title-preface", message: "Place the title before reader-facing document copy.", text: preface });
    }
    const next = blocks[blocks.indexOf(title) + 1];
    const summary = normalize(next?.textContent);
    if (!next || next.localName !== "p" || words(summary) < 12) {
      issues.push({ code: "opening-summary", message: "Follow the title immediately with a complete explanatory summary.", text: summary || undefined });
    }
    const header = title.closest("header");
    if (header && next) {
      for (const child of [...header.children]) {
        if (child.contains(title) || child.contains(next) || child.localName === "nav") continue;
        const childText = normalize(child.textContent);
        if (childText && !isHidden(child)) {
          issues.push({ code: "masthead-extra", message: "Keep the document opening to the title, explanatory summary, and optional navigation.", text: childText });
        }
      }
    }
  }

  for (const heading of headings.filter((element) => element.localName !== "h1")) {
    const text = normalize(heading.textContent);
    const limit = heading.localName === "h2" ? 6 : 9;
    if (words(text) > limit) issues.push({ code: "heading-length", message: `${heading.localName} should be an indexable mechanism name in ${limit} words or fewer.`, text });
    if (/^(?:key|useful|important|essential|critical|quick|simple)\b/i.test(text)) {
      issues.push({ code: "heading-filler", message: `${heading.localName} should name the mechanism without an evaluative modifier.`, text });
    }
    if (/^(?:what|why|how|when|where|which|who)\b/i.test(text)) {
      issues.push({ code: "heading-question", message: `${heading.localName} should use the mechanism name; keep the authoring question private.`, text });
    }
    if (/[:,;.!?]/.test(text) || headingVerb.test(text)) issues.push({ code: "heading-thesis", message: `${heading.localName} should name a mechanism rather than state a thesis.`, text });
    if (heading.localName === "h2") {
      const symbols = text.match(/\b(?:[a-z]\w*_\w+|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+)\b/g) ?? [];
      if (symbols.length >= 2 || /_/.test(text)) {
        issues.push({ code: "heading-symbol-inventory", message: "Use the architectural mechanism name instead of an implementation-symbol inventory.", text });
      }
    }
  }

  const peerSections = [...document.querySelectorAll("main section[id]")].filter((element) => !isHidden(element));
  if (peerSections.length >= 4) {
    if (!document.querySelector("[data-ve-topbar]")) {
      issues.push({ code: "navigation-topbar", message: "Substantial HTML needs a persistent document-level top bar." });
    }

    const toc = document.querySelector("nav[data-ve-toc]");
    if (!toc) {
      issues.push({ code: "navigation-toc", message: "Substantial HTML needs a page-local table of contents." });
    } else {
      const links = [...toc.querySelectorAll("a[href^='#']")];
      const targets = new Map(links.map((link) => [link.getAttribute("href")?.slice(1) ?? "", link]));
      for (const section of peerSections) {
        const link = targets.get(section.id);
        if (!link) {
          issues.push({ code: "navigation-target", message: "The page-local table of contents must link every peer section.", text: section.id });
          continue;
        }
        const heading = section.querySelector(":scope > h2");
        if (heading && normalize(link.textContent) !== normalize(heading.textContent)) {
          issues.push({ code: "navigation-label", message: "Table-of-contents labels must match their section headings.", text: normalize(link.textContent) });
        }
      }
    }
  }

  const prose = [...document.querySelectorAll("p, li, figcaption")].filter((element) => !isHidden(element));
  const seen = new Map<string, number>();
  const prefixes = new Map<string, { count: number; text: string }>();
  let strongLeadCount = 0;
  let strongLeadText = "";
  let pathCaptionCount = 0;
  let pathCaptionText = "";
  for (const element of prose) {
    const text = normalize(element.textContent);
    if (!text) continue;

    if (/^(?:reader|audience|scope)\s*:/i.test(text)) {
      issues.push({ code: "audience-metadata", message: "Integrate necessary audience or scope information into explanatory prose.", text });
    }
    if (/^\d{1,2}\s*(?:\/|·|—|-)\s*\S/.test(text)) {
      issues.push({ code: "section-eyebrow", message: "Use the section heading itself instead of a numbered eyebrow label.", text });
    }
    const blockIndex = blocks.indexOf(element);
    const nextBlock = blocks[blockIndex + 1];
    if (/\?$/.test(text) && nextBlock && /^h[2-3]$/.test(nextBlock.localName)) {
      issues.push({ code: "section-question", message: "Keep the teaching question private and begin the section with its mechanism heading.", text });
    }
    if (/\b(?:(?:this|the)\s+(?:visual|diagram|page|document|section|table)\s+(?:shows|lists|explains|presents|walks)|use\s+(?:the\s+)?(?:steps|tabs|controls)|select\s+(?:a|the)\s+[^.]{0,40}\s+to\s+(?:show|expose)|why\s+this\s+[^.]{0,40}\s+matters|(?:stable\s+)?mental\s+model|(?:rule|point|idea)\s+to\s+(?:remember|keep\s+in\s+mind)|why\s+it\s+matters|(?:source\s+model|architecture\s+details)(?:\s+(?:is|are))?\s+(?:derived|recovered)|(?:these\s+files|these\s+locations)\s+(?:contain|hold)|start\s+with\s+these\s+files|(?:central|core)\s+rule\s+is\s+simple|pinned\s+source|static\s+(?:artifact|reference)|no\s+(?:terminal\s+or\s+)?browser|no\s+desktop\s+automation|architecture\s+reference\s+for|(?:order|sequence)\s+(?:below|above)\s+is\s+(?:source-)?exact)\b/i.test(text)) {
      issues.push({ code: "construction-commentary", message: "Explain the mechanism directly instead of narrating the document or its controls.", text });
    }
    const strong = element.firstElementChild;
    if (strong?.localName === "strong" && text.startsWith(normalize(strong.textContent))) {
      strongLeadCount += 1;
      strongLeadText ||= text;
    }
    const prefix = text.match(/^([A-Za-z][A-Za-z -]{0,24}):\s+/)?.[1]?.toLowerCase();
    if (prefix) {
      const current = prefixes.get(prefix) ?? { count: 0, text };
      current.count += 1;
      prefixes.set(prefix, current);
    }

    if (text.length >= 24) {
      const key = text.toLowerCase();
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count === 2) issues.push({ code: "duplicate-copy", message: "Remove repeated reader-facing copy.", text });
    }
  }

  if (strongLeadCount >= 3) {
    issues.push({ code: "repeated-strong-lead", message: "Replace repeated bold lead-sentence callouts with direct prose or meaningful structure.", text: strongLeadText });
  }
  for (const element of [...document.querySelectorAll("*")].filter((candidate) => candidate.children.length === 0 && !isHidden(candidate) && !candidate.closest("table, pre, code"))) {
    const text = normalize(element.textContent);
    if (/\.rs\b/.test(text) && words(text) <= 12 && !/[.!?]$/.test(text)) {
      pathCaptionCount += 1;
      pathCaptionText ||= text;
    }
  }

  if (pathCaptionCount >= 2) {
    issues.push({ code: "repeated-path-caption", message: "Place a source path beside the mechanism or excerpt it substantiates instead of distributing path captions through the narrative.", text: pathCaptionText });
  }


  for (const [prefix, value] of prefixes) {

    if (value.count >= 3) issues.push({ code: "repeated-label", message: `Replace the repeated “${prefix}:” callout formula with direct prose or structure.`, text: value.text });
  }

  for (const section of [...document.querySelectorAll("section")]) {
    const heading = section.querySelector(":scope > h2, :scope > h3");
    if (!heading || !/^(?:(?:useful|key|important)\s+)?(?:source locations?|source index|file map|repository map|code locations?)$/i.test(normalize(heading.textContent))) continue;
    if (!section.hasAttribute("data-required")) {
      issues.push({ code: "detached-source-index", message: "Keep source paths beside the mechanisms they substantiate; omit a detached source index unless the user explicitly requested it.", text: normalize(heading.textContent) });
    }
  }

  for (const element of [...document.querySelectorAll("*")].filter((candidate) => candidate.children.length === 0 && !isHidden(candidate))) {
    const text = normalize(element.textContent);
    if (/\b(?:blue|green|red|purple|orange|amber)\s+(?:containment|authority|ownership)\b/i.test(text)) {
      issues.push({ code: "opaque-encoding", message: "Describe the concrete mark-to-relationship mapping instead of naming a color and abstraction.", text });
    }
  }

  const legends = [...document.querySelectorAll(".legend")].filter((element) => !isHidden(element) && normalize(element.textContent));
  if (legends.length >= 3) {
    issues.push({ code: "repeated-legend", message: "Prefer direct labels; do not narrate color or position after every visual.", text: normalize(legends[0].textContent) });
  }

  for (const element of [...document.querySelectorAll("*")].filter((candidate) => candidate.children.length === 0 && !isHidden(candidate) && !["p", "li", "figcaption"].includes(candidate.localName))) {
    const text = normalize(element.textContent);
    if (/\b(?:stable\s+mental\s+model|governing\s+rule|why\s+this\s+[^.]{0,40}\s+matters)\b/i.test(text)) {
      issues.push({ code: "construction-commentary", message: "Explain the mechanism directly instead of narrating the document or its controls.", text });
    }
  }

  const callouts = [...document.querySelectorAll(".callout")].filter((element) => !isHidden(element) && normalize(element.textContent));
  if (callouts.length >= 5) {
    issues.push({ code: "cardized-prose", message: "Consolidate repeated titled callouts into document flow or a source-shaped visual.", text: normalize(callouts[0].textContent) });
  }

  for (const footer of [...document.querySelectorAll("footer:not([data-required])")].filter((element) => !isHidden(element))) {
    const text = normalize(footer.textContent);
    if (text) issues.push({ code: "footer-copy", message: "Omit reader-facing footer copy unless the user requires legal or source metadata.", text });
  }

  return issues;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun lint-visible-copy.ts <artifact.html>");
    process.exit(2);
  }
  const issues = lintVisibleCopy(await readFile(path, "utf8"));
  if (issues.length === 0) {
    console.log("Visible copy passed.");
  } else {
    for (const issue of issues) console.error(`${issue.code}: ${issue.message}${issue.text ? `\n  ${issue.text}` : ""}`);
    process.exit(1);
  }
}
