# Generated Visuals

Use generated imagery only when it adds observable information that diagrams, code, tables, and existing source assets cannot provide.

## Qualification

Before loading `$imagegen`, complete this private sentence:

> This image teaches **[specific relationship or physical appearance]** by showing **[concrete subject]**, which a code-native visual cannot show because **[reason]**.

The qualification succeeds when it names observable content and a distinct explanatory role.

## Direction from evidence

Derive the prompt from user requirements and source evidence:

- concrete subject and arrangement;
- required geometry, count, identity, and direction;
- viewpoint needed to reveal the relationship;
- materials, environment, or appearance when they carry information;
- invariants supplied by references;
- space needed for external annotations.

Specify a style or palette only when the user, source material, or established project identity supplies one. Otherwise ask for a clear instructional rendering and let observable constraints drive the image.

Keep the bitmap text-free. Add exact terminology, connectors, and labels in accessible HTML or SVG.

## Prompt scaffold

```text
Use case: scientific-educational
Asset type: supporting explanatory image
Teaching job: <relationship or appearance the image must reveal>
Subject and arrangement: <source-grounded content>
Viewpoint: <view needed to expose the relationship>
Invariants: <geometry, count, identity, direction, and preserved reference details>
Annotation space: <location and amount>
Constraints: text-free image; no invented mechanisms or interface content
```

Add source- or user-derived style constraints only when they affect meaning or identity.

## Acceptance

Integrate the image when:

1. the bitmap retains its teaching value without overlaid labels;
2. the subject and arrangement are specific to the artifact;
3. depicted mechanics and geometry agree with the source;
4. important identity, count, and direction are clear;
5. the bitmap contains no generated technical text or ambiguous interface symbols;
6. it adds information not already explained better by an adjacent code-native visual.

When one criterion misses, make one targeted regeneration naming that criterion. When a second result still misses, continue with the stronger code-native visual.

## Integration

- Keep the image beside the mechanism it supports.
- Size it according to explanatory value.
- Add exact labels outside the bitmap.
- State the limited mapping when a metaphor is used.
- Embed the image in self-contained HTML. Use a sidecar asset only when the delivery contract explicitly permits external files.
- Write alt text for explanatory content.
