import { describe, expect, test } from "bun:test";
import { lintVisibleCopy } from "./lint-visible-copy";

describe("lintVisibleCopy", () => {
  test("accepts compact source-shaped copy", () => {
    const issues = lintVisibleCopy(`
      <title>Queue runtime</title>
      <header>
        <h1>Queue runtime</h1>
        <p>One scheduler applies accepted commands before it publishes a snapshot, so consumers never observe partially applied state.</p>
      </header>
      <main>
        <section><h2>Update schedule</h2><p>The input phase records commands before the mutation phase changes queue ownership.</p></section>
        <section><h2>Failure recovery</h2><p>A failed write retains the prior checkpoint, so the next worker resumes from durable state.</p></section>
      </main>
    `);
    expect(issues).toEqual([]);
  });

  test("rejects editorial packaging and document narration", () => {
    const issues = lintVisibleCopy(`
      <header>
        <p>Architecture reference</p>
        <h1>Queue: one authoritative runtime behind every projection</h1>
        <p>Reader: engineers · Scope: runtime, storage, workers</p>
      </header>
      <main>
        <p>01 / Runtime topology</p>
        <section>
          <p>What owns the queue?</p>
          <h2>One worker owns mutations; helpers only return facts</h2>
          <h3>Workers own the current queue</h3>
          <p>Use the steps to follow the mental model.</p>
          <p>The diagram shows the worker boundary.</p>
          <p>Consequence: stale workers cannot write.</p>
          <p>Consequence: retries preserve order.</p>
          <p>Consequence: consumers see complete snapshots.</p>
        </section>
      </main>
    `);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "title-length",
      "title-thesis",
      "document-title",
      "title-preface",
      "opening-summary",
      "audience-metadata",
      "section-eyebrow",
      "section-question",
      "heading-length",
      "heading-thesis",
      "construction-commentary",
      "repeated-label",
    ]));
  });
  test("rejects repeated bold callouts and provenance filler", () => {
    const issues = lintVisibleCopy(`
      <title>Queue runtime</title>
      <h1>Queue runtime</h1>
      <p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p>
      <h2>Update schedule</h2>
      <p><strong>First claim.</strong> The input phase records one command.</p>
      <p><strong>Second claim.</strong> The mutation phase changes queue ownership.</p>
      <p><strong>Third claim.</strong> The projection phase publishes complete state.</p>
      <p>Architecture details are derived from the source paths listed above.</p>
    `);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "repeated-strong-lead",
      "construction-commentary",
    ]));
  });


  test("rejects evaluation metadata and distributed path captions", () => {
    const issues = lintVisibleCopy(`
      <title>Queue runtime</title>
      <header>
        <div><h1>Queue runtime</h1><p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p></div>
        <aside><strong>Governing rule</strong> Workers return facts.</aside>
      </header>
      <main>
        <p>crates/queue/src/runtime.rs · worker.rs</p>
        <p>crates/queue/src/store.rs · records.rs</p>
        <p>Blue containment is mutation authority.</p>
        <p>The order below is source-exact.</p>
        <section><h2>Useful source locations</h2><p>These modules contain the mechanisms described above.</p><table><tr><td>runtime.rs</td></tr></table></section>
      </main>
      <footer>Pinned source: abcdef1. Static artifact; no browser automation used.</footer>
    `);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "masthead-extra",
      "repeated-path-caption",
      "detached-source-index",
      "heading-filler",
      "opaque-encoding",
      "construction-commentary",
      "footer-copy",
    ]));
  });

  test("rejects symbol headings, detached source indexes, and cardized prose", () => {
    const issues = lintVisibleCopy(`
      <title>Queue runtime</title>
      <h1>Queue runtime</h1>
      <p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p>
      <h2>RequestState and WorkerState</h2>
      <section><h2>Source locations</h2><div>runtime.rs</div></section>
      <div class="callout"><h3>Ownership</h3><p>Queue owns one worker.</p></div>
      <div class="callout"><h3>Ingress</h3><p>Clients send commands.</p></div>
      <div class="callout"><h3>Mutation</h3><p>The worker applies commands.</p></div>
      <div class="callout"><h3>Projection</h3><p>The worker publishes snapshots.</p></div>
      <div class="callout"><h3>Recovery</h3><p>The store retains checkpoints.</p></div>
    `);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "heading-symbol-inventory",
      "detached-source-index",
      "cardized-prose",
    ]));
  });

  test("allows an explicitly requested source index", () => {
    expect(lintVisibleCopy(`
      <title>Queue runtime</title>
      <h1>Queue runtime</h1>
      <p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p>
      <section data-required><h2>Source locations</h2><table><tr><td>runtime.rs</td></tr></table></section>
    `)).toEqual([]);
  });

  test("accepts persistent navigation for substantial references", () => {
    expect(lintVisibleCopy(`
      <title>Queue runtime</title>
      <header data-ve-topbar><a href="#top">Queue</a></header>
      <div id="top">
        <nav data-ve-toc aria-label="Page contents">
          <a href="#topology">Runtime topology</a>
          <a href="#schedule">Update schedule</a>
          <a href="#recovery">Failure recovery</a>
          <a href="#delivery">Delivery outcomes</a>
        </nav>
        <main>
          <h1>Queue runtime</h1>
          <p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p>
          <section id="topology"><h2>Runtime topology</h2></section>
          <section id="schedule"><h2>Update schedule</h2></section>
          <section id="recovery"><h2>Failure recovery</h2></section>
          <section id="delivery"><h2>Delivery outcomes</h2></section>
        </main>
      </div>
    `)).toEqual([]);
  });

  test("requires persistent navigation for substantial references", () => {
    const issues = lintVisibleCopy(`
      <title>Queue runtime</title>
      <main>
        <h1>Queue runtime</h1>
        <p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p>
        <section id="topology"><h2>Runtime topology</h2></section>
        <section id="schedule"><h2>Update schedule</h2></section>
        <section id="recovery"><h2>Failure recovery</h2></section>
        <section id="delivery"><h2>Delivery outcomes</h2></section>
      </main>
    `);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "navigation-topbar",
      "navigation-toc",
    ]));
  });

  test("ignores hidden template copy", () => {
    expect(lintVisibleCopy(`<title>Runtime</title><h1>Runtime</h1><p>One scheduler applies accepted commands before publishing a complete snapshot to every consumer.</p><template><p>Use the steps to follow the mental model.</p></template>`)).toEqual([]);
  });
});
