/* Wrap the Artifact fragment (index.html) into a standalone document for hosting.
   The Artifact host supplies its own <head>, so index.html deliberately has none;
   a hosted copy needs the doctype, language, direction and viewport itself. */
import { readFile, writeFile, mkdir } from "node:fs/promises";

const body = await readFile(new URL("./index.html", import.meta.url), "utf8");
const title = (body.match(/<title>([^<]*)<\/title>/) || [, "مكتب الحوالات"])[1];

const page = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0B6E62" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0A1211" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%92%B1%3C/text%3E%3C/svg%3E">
<style>*{margin:0;padding:0}</style>
</head>
<body>
${body}
</body>
</html>
`;

await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await writeFile(new URL("./dist/index.html", import.meta.url), page);
console.log(`dist/index.html  ${Buffer.byteLength(page)} bytes`);
