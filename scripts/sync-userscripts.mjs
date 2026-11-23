import { readFileSync, writeFileSync } from 'node:fs';

const [mode, ...extraArgs] = process.argv.slice(2);
if ((mode !== undefined && mode !== '--check') || extraArgs.length) {
    throw new Error('Usage: node scripts/sync-userscripts.mjs [--check]');
}

const sourceFile = new URL('../komga-metadata-scraper.user.js', import.meta.url);
const outputFile = new URL('../komga-metadata-scraper-next.user.js', import.meta.url);

function readScript(file) {
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const lines = readScript(sourceFile).split('\n');
const headerEnd = lines.indexOf('// ==/UserScript==');
if (lines[0] !== '// ==UserScript==' || headerEnd < 1) {
    throw new Error('Missing userscript metadata header');
}

const startMarker = '    // BEGIN CLASSIC UI';
const endMarker = '    // END CLASSIC UI';
const start = lines.indexOf(startMarker);
const end = lines.indexOf(endMarker);
if (start <= headerEnd || end <= start
    || lines.lastIndexOf(startMarker) !== start || lines.lastIndexOf(endMarker) !== end) {
    throw new Error('Expected exactly one Classic UI adapter block');
}
lines.splice(start, end - start + 1);

function replaceMetadata(field, update) {
    const pattern = new RegExp('^(// @' + field + '[ \\t]+)(.+)$');
    const index = lines.slice(1, headerEnd).findIndex(line => pattern.test(line)) + 1;
    if (index === 0) throw new Error('Missing @' + field + ' in userscript metadata');
    lines[index] = lines[index].replace(pattern, (_, prefix, value) => prefix + update(value));
}

replaceMetadata('name', value => value + ' (Next UI)');
replaceMetadata('description', value => {
    const compatibility = '兼容 Next UI 和 Classic UI';
    if (!value.includes(compatibility)) throw new Error('Missing UI compatibility in @description');
    return value.replace(compatibility, '适用于 Next UI');
});
lines.splice(headerEnd + 1, 0, '', '// 由 scripts/sync-userscripts.mjs 从 komga-metadata-scraper.user.js 生成。');
const generated = lines.join('\n');

if (mode === '--check') {
    let actual;
    try {
        actual = readScript(outputFile);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (actual !== generated) {
        console.error('Next UI 专用版未同步。请运行 node scripts/sync-userscripts.mjs。');
        process.exitCode = 1;
    }
} else {
    writeFileSync(outputFile, generated, 'utf8');
}
