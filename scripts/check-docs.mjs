/**
 * Verifies that the documentation tells the truth.
 *
 * Every number in the READMEs — coverage, bundle size, test count — is checked
 * against a measurement taken right now, and the two READMEs are checked
 * against each other for the facts they both state. Docs drift because nothing
 * stops them; this stops them.
 *
 * Requires `npm run coverage` and `npm run build` to have run first.
 * Wired into `npm run ci`.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages/tickwork');

const failures = [];
const checks = [];

function check(label, ok, detail) {
  checks.push({ label, ok });
  if (!ok) failures.push(`${label}\n    ${detail}`);
}

function requireFile(path, hint) {
  if (existsSync(path)) return true;
  failures.push(`missing ${path}\n    ${hint}`);
  return false;
}

// ---------------------------------------------------------------- measurements

/** min+gzip size in kB, one decimal, of a bundle exporting `names` from dist. */
async function measureBundleKb(names) {
  const entry =
    names === null
      ? `export * from ${JSON.stringify(join(pkgDir, 'dist/index.mjs'))};`
      : `export { ${names.join(', ')} } from ${JSON.stringify(join(pkgDir, 'dist/index.mjs'))};`;

  const result = await build({
    stdin: { contents: entry, resolveDir: pkgDir, sourcefile: 'entry.mjs', loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    external: ['react', 'react-dom'],
    write: false,
    logLevel: 'silent',
  });

  const bytes = gzipSync(Buffer.from(result.outputFiles[0].contents), { level: 9 }).length;
  return { bytes, kb: Math.round((bytes / 1000) * 10) / 10 };
}

const coveragePath = join(pkgDir, 'coverage/coverage-summary.json');
const testsPath = join(pkgDir, 'coverage/test-results.json');

if (
  !requireFile(coveragePath, 'run `npm run coverage` first') ||
  !requireFile(testsPath, 'run `npm run coverage` first') ||
  !requireFile(join(pkgDir, 'dist/index.mjs'), 'run `npm run build` first')
) {
  console.error('\n✗ check-docs cannot run:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
const testResults = JSON.parse(readFileSync(testsPath, 'utf8'));
const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
const pkgReadme = readFileSync(join(pkgDir, 'README.md'), 'utf8');

const full = await measureBundleKb(null);
const core = await measureBundleKb([
  'createRealtimeStore',
  'useRealtimeValue',
  'useRealtimeKeys',
  'useWebSocketFeed',
  'createJsonParser',
]);

// ------------------------------------------------------------------ test count

const totalTests = testResults.numTotalTests;
const claimedCounts = [...rootReadme.matchAll(/(\d+) tests/g)].map((m) => Number(m[1]));
check(
  `README test count (${totalTests} tests)`,
  claimedCounts.length > 0 && claimedCounts.every((n) => n === totalTests),
  `README claims ${claimedCounts.join(', ') || 'nothing'}; the suite has ${totalTests}. ` +
    `Update every "N tests" in README.md.`,
);

// -------------------------------------------------------------------- coverage

const pct = (entry, key) => Math.round(entry[key].pct * 10) / 10;
const oneDp = (value) => Math.round(value * 10) / 10;

// Claims may lag a real improvement by up to a point, but must never overstate.
function checkCoverageClaim(label, claimed, actual) {
  const ok = claimed <= actual + 0.05 && claimed >= actual - 1.0;
  check(
    `coverage ${label} (${claimed}% claimed, ${oneDp(actual)}% actual)`,
    ok,
    claimed > actual
      ? `README overstates coverage. Actual is ${oneDp(actual)}%.`
      : `README understates coverage by more than a point. Actual is ${oneDp(actual)}%.`,
  );
}

const totalStatements = coverage.total.statements.pct;
const totalBranches = coverage.total.branches.pct;

const badgeMatch = rootReadme.match(/coverage-(\d+)%25/);
check(
  'coverage badge',
  badgeMatch !== null && Number(badgeMatch[1]) <= Math.round(totalStatements),
  `badge says ${badgeMatch?.[1]}%, actual statements ${oneDp(totalStatements)}%`,
);

// Per-file rows: | `store.ts` | 100% | 98.7% |
const fileRows = [...rootReadme.matchAll(/\|\s*`([\w.-]+\.tsx?)`\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)%\s*\|/g)];
check('coverage table has rows', fileRows.length > 0, 'no per-file coverage rows found in README.md');

for (const [, file, statements, branches] of fileRows) {
  const entry = Object.entries(coverage).find(
    ([path]) => path !== 'total' && path.endsWith(`/${file}`),
  );
  if (entry === undefined) {
    check(`coverage row \`${file}\``, false, `README lists ${file}, but coverage has no such file`);
    continue;
  }
  checkCoverageClaim(`${file} statements`, Number(statements), pct(entry[1], 'statements'));
  checkCoverageClaim(`${file} branches`, Number(branches), pct(entry[1], 'branches'));
}

const totalRow = rootReadme.match(/\|\s*\*\*All\*\*\s*\|\s*\*\*([\d.]+)%\*\*\s*\|\s*\*\*([\d.]+)%\*\*\s*\|/);
check('coverage total row present', totalRow !== null, 'no **All** row in the coverage table');
if (totalRow !== null) {
  checkCoverageClaim('total statements', Number(totalRow[1]), totalStatements);
  checkCoverageClaim('total branches', Number(totalRow[2]), totalBranches);
}

// ----------------------------------------------------------------- bundle size

// A size claim must never be smaller than reality, and must stay close to it.
function checkSizeClaim(label, claimedKb, measured) {
  const ok = claimedKb >= measured.kb - 0.05 && claimedKb <= measured.kb + 0.5;
  check(
    `${label} (${claimedKb} kB claimed, ${measured.kb} kB actual)`,
    ok,
    claimedKb < measured.kb
      ? `README understates the bundle: it is ${measured.kb} kB (${measured.bytes} B) min+gzip.`
      : `README is stale by more than 0.5 kB; actual is ${measured.kb} kB.`,
  );
}

const badgeSize = rootReadme.match(/min%2Bgzip-([\d.]+)%20kB/);
check('bundle size badge present', badgeSize !== null, 'no min+gzip badge in README.md');
if (badgeSize !== null) checkSizeClaim('size badge', Number(badgeSize[1]), full);

const fullRow = rootReadme.match(/Everything, including[^|]*\|\s*\*\*([\d.]+) kB\*\*/);
check('bundle size table: full row', fullRow !== null, 'no "Everything, including" row');
if (fullRow !== null) checkSizeClaim('size table (full)', Number(fullRow[1]), full);

const coreRow = rootReadme.match(/Headless core[^|]*\|\s*\*\*([\d.]+) kB\*\*/);
check('bundle size table: core row', coreRow !== null, 'no "Headless core" row');
if (coreRow !== null) checkSizeClaim('size table (core)', Number(coreRow[1]), core);

// ------------------------------------------------- the two READMEs agree

const shared = [
  { label: 'bundle size', pattern: /4\.6 kB min\+gzip|min%2Bgzip-4\.6%20kB/ },
  { label: 'install command', pattern: /npm install tickwork/ },
  { label: 'license line', pattern: /MIT © Anton Bochkarev/ },
];

for (const { label, pattern } of shared) {
  check(
    `both READMEs state the ${label}`,
    pattern.test(rootReadme) && pattern.test(pkgReadme),
    `${label} appears in ${pattern.test(rootReadme) ? 'root' : 'package'} README only. ` +
      `Both must agree (pattern: ${pattern}).`,
  );
}

// The package README's size claim must match the measured one too.
const pkgSize = pkgReadme.match(/([\d.]+) kB min\+gzip/);
check('package README size claim', pkgSize !== null, 'no "N kB min+gzip" in packages/tickwork/README.md');
if (pkgSize !== null) checkSizeClaim('package README size', Number(pkgSize[1]), full);

// ---------------------------------------------------------------------- report

const passed = checks.filter((c) => c.ok).length;
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} documentation claim(s) do not match reality:\n`);
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `✓ docs check: ${passed} claims verified — ${totalTests} tests, ` +
    `${oneDp(totalStatements)}% statements / ${oneDp(totalBranches)}% branches, ` +
    `${core.kb} kB core / ${full.kb} kB full (min+gzip)`,
);
