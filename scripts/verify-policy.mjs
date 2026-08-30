import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const fail = (message) => {
  throw new Error(message);
};

const invocationRoot = process.cwd();
const rootArguments = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--candidate-root', '--base-root'].includes(flag) || value === undefined) {
    fail(`Usage: node scripts/verify-policy.mjs [--candidate-root PATH --base-root PATH]`);
  }
  if (rootArguments.has(flag)) fail(`Duplicate verifier argument: ${flag}`);
  rootArguments.set(flag, value);
}

const resolvePolicyRoot = (flag, fallback) => {
  const requested = rootArguments.get(flag) ?? fallback;
  const resolved = path.resolve(invocationRoot, requested);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`Policy root does not exist: ${resolved}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`Policy root must be a real directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
};

const candidateRoot = resolvePolicyRoot('--candidate-root', invocationRoot);
const baseRoot = resolvePolicyRoot(
  '--base-root',
  rootArguments.get('--candidate-root') ?? invocationRoot,
);
process.chdir(candidateRoot);

const stripYamlComment = (line) => {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
};

const unquoteYamlScalar = (source, context) => {
  const value = source.trim();
  if (value.startsWith("'") || value.startsWith('"')) {
    const quote = value[0];
    if (!value.endsWith(quote) || value.length < 2) {
      fail(`Unterminated quoted YAML scalar in ${context}`);
    }
    if (quote === "'") return value.slice(1, -1).replaceAll("''", "'");
    try {
      return JSON.parse(value);
    } catch {
      fail(`Invalid double-quoted YAML scalar in ${context}`);
    }
  }
  return value;
};

const findYamlColon = (source) => {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && source[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') doubleQuoted = true;
    else if (character === "'") singleQuoted = true;
    else if (character === ':') return index;
  }
  return -1;
};

const containsYamlReference = (source) => {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let visible = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (doubleQuoted) {
      visible += ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (singleQuoted) {
      visible += ' ';
      if (character === "'" && source[index + 1] === "'") {
        visible += ' ';
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      visible += ' ';
    } else if (character === "'") {
      singleQuoted = true;
      visible += ' ';
    } else {
      visible += character;
    }
  }
  const node = visible.trimStart();
  return /^(?:-\s*)?[&*](?![&*])(?=\S)/u.test(node) ||
    /[{\[,:]\s*[&*](?![&*])(?=[^\s,[\]{}])/u.test(visible);
};

const parseYamlEntries = (source, file) => {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const entries = [];
  let blockScalarIndent = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const indentation = rawLine.match(/^[ \t]*/u)?.[0] ?? '';
    if (indentation.includes('\t')) {
      fail(`Tabs are not allowed in workflow indentation: ${file}:${lineIndex + 1}`);
    }
    const indent = indentation.length;
    if (blockScalarIndent !== null) {
      if (rawLine.trim() === '' || indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    const uncommented = stripYamlComment(rawLine);
    let body = uncommented.slice(indent).trimEnd();
    if (body === '') continue;
    if (/^(?:-\s*)?[?:](?:\s|$)/u.test(body)) {
      fail(`Explicit YAML mapping keys are not allowed: ${file}:${lineIndex + 1}`);
    }
    if (/^\s*(?:-\s*)?<<\s*:/u.test(body) || containsYamlReference(body)) {
      fail(`YAML anchors, aliases, and merge keys are not allowed: ${file}:${lineIndex + 1}`);
    }
    if (/^-\s*$/u.test(body)) {
      fail(`Bare YAML sequence entries are not allowed: ${file}:${lineIndex + 1}`);
    }
    if (/^-\s*\{/u.test(body)) {
      fail(`Flow-style workflow steps are not allowed: ${file}:${lineIndex + 1}`);
    }
    let listItem = false;
    if (/^-\s+/u.test(body)) {
      listItem = true;
      body = body.replace(/^-\s+/u, '');
    }
    const colon = findYamlColon(body);
    if (colon < 0) continue;
    const rawKey = body.slice(0, colon).trim();
    if (!/^(?:[A-Za-z_][A-Za-z0-9_-]*|"(?:\\.|[^"])*"|'(?:''|[^'])*')$/u
        .test(rawKey)) {
      continue;
    }
    const key = unquoteYamlScalar(rawKey, `${file}:${lineIndex + 1} key`);
    if (key === '<<') {
      fail(`YAML merge keys are not allowed: ${file}:${lineIndex + 1}`);
    }
    const value = body.slice(colon + 1).trim();
    if (key === 'run' && value.startsWith('>')) {
      fail(`Folded YAML run scalars are not allowed: ${file}:${lineIndex + 1}`);
    }
    const entry = {
      file,
      line: lineIndex,
      lineNumber: lineIndex + 1,
      indent,
      listItem,
      key,
      value,
    };
    entries.push(entry);
    if (/^[>|][+-]?[0-9]*$/u.test(value)) blockScalarIndent = indent;
  }
  return { entries, lines };
};

const splitFlowItems = (source, context) => {
  const items = [];
  let start = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let nested = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (doubleQuoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && source[index + 1] === "'") index += 1;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (character === '"') doubleQuoted = true;
    else if (character === "'") singleQuoted = true;
    else if (character === '{' || character === '[') nested += 1;
    else if (character === '}' || character === ']') nested -= 1;
    else if (character === ',' && nested === 0) {
      items.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (singleQuoted || doubleQuoted || nested !== 0) {
    fail(`Malformed flow mapping in ${context}`);
  }
  items.push(source.slice(start).trim());
  return items.filter(Boolean);
};

const parseFlowMap = (source, context) => {
  const value = source.trim();
  if (!value.startsWith('{') || !value.endsWith('}')) {
    fail(`Unsupported inline mapping in ${context}`);
  }
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlowItems(inner, context).map((item) => {
    const colon = findYamlColon(item);
    if (colon < 0) fail(`Malformed flow mapping entry in ${context}`);
    const key = unquoteYamlScalar(item.slice(0, colon), context);
    const scalar = unquoteYamlScalar(item.slice(colon + 1), context);
    return { key, scalar };
  });
};

const normalizeShellContinuations = (source) => source
  .replace(/\\\r?\n/gu, '')
  .replace(/`\r?\n/gu, '');

const shellTokens = (source) => {
  const tokens = source.match(
    /"(?:\\.|[^"])*"|'[^']*'|&&|\|\||[;|()]|[^\s;&|()]+/gu,
  ) ?? [];
  return tokens.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
};

const findGitCommands = (source) => {
  const commands = [];
  const normalized = normalizeShellContinuations(source);
  for (const rawLine of normalized.split('\n')) {
    const line = stripYamlComment(rawLine).trim();
    if (line === '') continue;
    const tokens = shellTokens(line);
    for (let index = 0; index < tokens.length; index += 1) {
      if (!/(?:^|[\\/])git(?:\.exe)?$/iu.test(tokens[index])) continue;
      const command = [];
      for (let cursor = index; cursor < tokens.length; cursor += 1) {
        if (cursor > index && [';', '&&', '||', '|', ')'].includes(tokens[cursor])) {
          break;
        }
        command.push(tokens[cursor]);
      }
      commands.push({ line, tokens: command });
    }
  }
  return commands;
};

const commandHasSubcommand = (command, subcommand) =>
  command.tokens.slice(1).includes(subcommand);

const duplicateKeys = (entries, context) => {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.key)) fail(`Duplicate YAML key ${entry.key} in ${context}`);
    seen.add(entry.key);
  }
};

const buildWorkflowModel = (source, file) => {
  const parsed = parseYamlEntries(source, file);
  duplicateKeys(
    parsed.entries.filter((entry) => entry.indent === 0 && !entry.listItem),
    `${file} top level`,
  );
  const jobsRoots = parsed.entries.filter(
    (entry) => entry.indent === 0 && !entry.listItem && entry.key === 'jobs',
  );
  if (jobsRoots.length !== 1 || jobsRoots[0].value !== '') {
    fail(`Workflow jobs must use one block mapping: ${file}`);
  }
  const jobsRoot = jobsRoots[0];
  const topLevelAfterJobs = parsed.entries.find(
    (entry) => entry.line > jobsRoot.line && entry.indent === 0,
  );
  const jobsEnd = topLevelAfterJobs?.line ?? parsed.lines.length;
  const jobStarts = parsed.entries.filter(
    (entry) => entry.line > jobsRoot.line && entry.line < jobsEnd &&
      entry.indent === 2 && !entry.listItem,
  );
  duplicateKeys(jobStarts, `${file} jobs`);
  const jobs = new Map();
  for (let index = 0; index < jobStarts.length; index += 1) {
    const start = jobStarts[index];
    if (start.value !== '') fail(`Workflow job must use a block mapping: ${file}:${start.key}`);
    const end = jobStarts[index + 1]?.line ?? jobsEnd;
    const entries = parsed.entries.filter(
      (entry) => entry.line > start.line && entry.line < end,
    );
    const jobLevelEntries = entries.filter(
      (entry) => entry.indent === 4 && !entry.listItem,
    );
    duplicateKeys(jobLevelEntries, `${file} job ${start.key}`);
    jobs.set(start.key, {
      id: start.key,
      start: start.line,
      end,
      entries,
      jobLevelEntries,
      source: parsed.lines.slice(start.line, end).join('\n'),
    });
  }
  return { ...parsed, file, jobs };
};

const extractSteps = (model, job) => {
  const stepsEntry = job.jobLevelEntries.find((entry) => entry.key === 'steps');
  if (!stepsEntry || stepsEntry.value !== '') return [];
  const starts = job.entries.filter(
    (entry) => entry.line > stepsEntry.line && entry.indent === 6 && entry.listItem,
  );
  const steps = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.line ?? job.end;
    const entries = job.entries.filter(
      (entry) => entry.line >= start.line && entry.line < end,
    );
    const directEntries = entries.filter(
      (entry) => (entry.line === start.line && entry.indent === 6) ||
        (entry.line > start.line && entry.indent === 8 && !entry.listItem),
    );
    duplicateKeys(directEntries, `${model.file} job ${job.id} step at line ${start.lineNumber}`);
    steps.push({
      start: start.line,
      end,
      entries,
      directEntries,
      source: model.lines.slice(start.line, end).join('\n'),
    });
  }
  return steps;
};

const MAX_POLICY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_ENTRIES = 128;
const frozenExecutableFiles = [
  '.github/workflows/relay-policy.yml',
  '.github/workflows/relay-process-environment.yml',
  'scripts/verify-policy.mjs',
  'scripts/test-policy.mjs',
  'relay',
];
const frozenAttributeFiles = [
  '.gitattributes',
  '.github/.gitattributes',
  'config/.gitattributes',
  'scripts/.gitattributes',
];

const assertRealDirectory = (root, relativePath) => {
  const absolutePath = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    fail(`Missing executable trust-root directory: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) {
    fail(`Symlinks are not allowed in the executable trust root: ${relativePath}`);
  }
  if (!stat.isDirectory()) {
    fail(`Executable trust-root path is not a directory: ${relativePath}`);
  }
};

const inspectRegularFile = (root, relativePath) => {
  const absolutePath = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    fail(`Missing executable trust-root file: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) {
    fail(`Symlinks are not allowed in the executable trust root: ${relativePath}`);
  }
  if (!stat.isFile()) {
    fail(`Executable trust-root path is not a regular file: ${relativePath}`);
  }
  if (stat.size > MAX_POLICY_FILE_BYTES) {
    fail(`Executable trust-root file is oversized: ${relativePath}`);
  }
  return {
    absolutePath,
    mode: stat.mode & 0o777,
    bytes: fs.readFileSync(absolutePath),
  };
};

const inspectOptionalRegularFile = (root, relativePath) => {
  const absolutePath = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail(`Symlinks are not allowed in the executable trust root: ${relativePath}`);
  }
  if (!stat.isFile()) {
    fail(`Executable trust-root path is not a regular file: ${relativePath}`);
  }
  if (stat.size > MAX_POLICY_FILE_BYTES) {
    fail(`Executable trust-root file is oversized: ${relativePath}`);
  }
  return {
    mode: stat.mode & 0o777,
    bytes: fs.readFileSync(absolutePath),
  };
};

const collectProfileFiles = (root) => {
  assertRealDirectory(root, 'profiles');
  const files = [];
  let entryCount = 0;
  const walk = (relativeDirectory) => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const name of fs.readdirSync(absoluteDirectory).sort()) {
      entryCount += 1;
      if (entryCount > MAX_PROFILE_ENTRIES) {
        fail(`Executable profile tree has more than ${MAX_PROFILE_ENTRIES} entries`);
      }
      const relativePath = path.join(relativeDirectory, name);
      const absolutePath = path.join(root, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        fail(`Symlinks are not allowed in the executable trust root: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        walk(relativePath);
      } else if (stat.isFile()) {
        if (stat.size > MAX_POLICY_FILE_BYTES) {
          fail(`Executable trust-root file is oversized: ${relativePath}`);
        }
        files.push(relativePath);
      } else {
        fail(`Executable trust-root path is not a regular file: ${relativePath}`);
      }
    }
  };
  walk('profiles');
  return files.sort();
};

for (const root of new Set([baseRoot, candidateRoot])) {
  assertRealDirectory(root, '.github');
  assertRealDirectory(root, '.github/workflows');
  assertRealDirectory(root, 'scripts');
  for (const relativePath of [
    ...frozenExecutableFiles,
    'config/targets.json',
  ]) {
    inspectRegularFile(root, relativePath);
  }
  for (const relativePath of frozenAttributeFiles) {
    inspectOptionalRegularFile(root, relativePath);
  }
  collectProfileFiles(root);
}

const config = JSON.parse(fs.readFileSync('config/targets.json', 'utf8'));
const expectedRegistryKeys = ['canary', 'policy', 'profiles', 'schema', 'targets'];
if (!config || Array.isArray(config) || typeof config !== 'object' ||
    !isDeepStrictEqual(Object.keys(config).sort(), expectedRegistryKeys)) {
  fail('Unexpected target-registry root keys');
}
const workflowDirectory = path.join('.github', 'workflows');
const expectedWorkflowFiles = [
  'relay-policy.yml',
  'relay-process-environment.yml',
];
const workflowFiles = fs.readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
if (JSON.stringify(workflowFiles) !== JSON.stringify(expectedWorkflowFiles)) {
  fail(`Unexpected workflow set: ${workflowFiles.join(', ')}`);
}
const workflows = Object.fromEntries(
  workflowFiles.map((file) => [
    file,
    fs.readFileSync(path.join(workflowDirectory, file), 'utf8'),
  ]),
);
const workflow = workflows['relay-process-environment.yml'];
const policyWorkflow = workflows['relay-policy.yml'];
const workflowModels = Object.fromEntries(
  Object.entries(workflows).map(([file, source]) => [
    file,
    buildWorkflowModel(source, file),
  ]),
);
const relayModel = workflowModels['relay-process-environment.yml'];
const policyModel = workflowModels['relay-policy.yml'];
for (const model of Object.values(workflowModels)) {
  for (const job of model.jobs.values()) extractSteps(model, job);
}

if (config.schema !== 'organvm.relay-targets.v4') {
  fail('Unexpected target-registry schema');
}
if (config.policy?.require_public_source !== true) {
  fail('Public source must be mandatory');
}
if (config.policy?.require_exact_40_hex_sha !== true) {
  fail('Exact commit SHAs must be mandatory');
}
if (config.policy?.deny_floating_refs !== true) {
  fail('Floating refs must be denied');
}
if (config.policy?.receipt_branch !== 'receipts') {
  fail('The durable receipt branch must be receipts');
}
if (!Array.isArray(config.policy?.allowed_secrets) ||
    config.policy.allowed_secrets.length !== 0) {
  fail('Target jobs may not receive secrets');
}

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const families = new Set(['process-environment', 'python']);
const exactPythonVersions = new Set(['3.11.16', '3.12.14']);
const exactNodeVersions = new Set(['22.23.2']);
if (!config.profiles || Array.isArray(config.profiles) ||
    typeof config.profiles !== 'object') {
  fail('Profile-family map must be an object');
}
for (const [name, profile] of Object.entries(config.profiles ?? {})) {
  if (!profilePattern.test(name)) fail(`Invalid profile: ${name}`);
  if (!profile || Array.isArray(profile) || typeof profile !== 'object') {
    fail(`Invalid profile definition: ${name}`);
  }
  if (!families.has(profile.family)) fail(`Invalid profile family: ${name}`);
  const expectedProfileKeys = profile.family === 'python'
    ? ['description', 'family', 'runtime']
    : ['description', 'family'];
  if (!isDeepStrictEqual(Object.keys(profile).sort(), expectedProfileKeys)) {
    fail(`Invalid profile definition: ${name}`);
  }
  if (typeof profile.description !== 'string' || profile.description.length === 0 ||
      profile.description.length > 200) {
    fail(`Invalid profile description: ${name}`);
  }
  if (profile.family === 'python') {
    const runtime = profile.runtime;
    if (!runtime || Array.isArray(runtime) || typeof runtime !== 'object') {
      fail(`Invalid frozen Python runtime: ${name}`);
    }
    const expectedRuntimeKeys = runtime.node_version === undefined
      ? ['python_versions']
      : ['node_version', 'python_versions'];
    if (!isDeepStrictEqual(Object.keys(runtime).sort(), expectedRuntimeKeys) ||
        !Array.isArray(runtime.python_versions) ||
        runtime.python_versions.length === 0 ||
        new Set(runtime.python_versions).size !== runtime.python_versions.length ||
        runtime.python_versions.some(
          (version) => typeof version !== 'string' || !exactPythonVersions.has(version),
        )) {
      fail(`Invalid frozen Python runtime: ${name}`);
    }
    if (runtime.node_version !== undefined &&
        (typeof runtime.node_version !== 'string' ||
          !exactNodeVersions.has(runtime.node_version))) {
      fail(`Invalid frozen Node runtime: ${name}`);
    }
  }
  const shellProfilePath = path.join('profiles', `${name}.sh`);
  if (!fs.existsSync(shellProfilePath)) {
    fail(`Missing relay-owned profile: ${name}`);
  }
  const executableProfilePaths = [shellProfilePath];
  if (profile.family === 'process-environment') {
    const windowsProfilePath = path.join('profiles', `${name}.ps1`);
    if (!fs.existsSync(windowsProfilePath)) {
      fail(`Missing Windows relay profile: ${name}`);
    }
    executableProfilePaths.push(windowsProfilePath);
  }
  for (const executableProfilePath of executableProfilePaths) {
    const source = fs.readFileSync(executableProfilePath, 'utf8');
    const gitDependencies = source.match(
      /git\+(?:https?|ssh|git|file):\/\/[^\s'"]+/gi,
    ) ?? [];
    for (const dependency of gitDependencies) {
      if (!dependency.startsWith('git+https://') ||
          !/\.git@[0-9a-f]{40}(?:[#?][^\s'"]*)?$/.test(dependency)) {
        fail(`Unpinned or unsupported Git dependency in ${executableProfilePath}`);
      }
    }
    const rawGitNetworkCommand = findGitCommands(source).find((command) =>
      ['clone', 'fetch', 'pull', 'submodule'].some((subcommand) =>
        commandHasSubcommand(command, subcommand)),
    );
    if (rawGitNetworkCommand) {
      fail(`Raw Git network command in ${executableProfilePath}`);
    }
  }
}

const targetPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
if (!config.targets || Array.isArray(config.targets) ||
    typeof config.targets !== 'object' || Object.keys(config.targets).length === 0) {
  fail('Target registry must be a non-empty object');
}
const targetRecords = Object.entries(config.targets);
const MAX_TARGET_RECORDS = 64;
const MAX_REGRESSION_JOBS = 32;
if (targetRecords.length > MAX_TARGET_RECORDS) {
  fail(`Target registry may contain at most ${MAX_TARGET_RECORDS} records`);
}
const targetNames = new Set();
const stableRepositoryIds = new Set();
let regressionJobCount = 0;
for (const [target, entry] of targetRecords) {
  if (!targetPattern.test(target)) fail(`Invalid target: ${target}`);
  const normalizedTarget = target.toLowerCase();
  if (target !== normalizedTarget || targetNames.has(normalizedTarget)) {
    fail(`Target names must be unique lowercase identities: ${target}`);
  }
  targetNames.add(normalizedTarget);
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
    fail(`Invalid target record: ${target}`);
  }
  const targetKeys = Object.keys(entry).sort();
  const expectedTargetKeys = entry.regression_candidate === undefined
    ? ['profiles', 'stable_repository_id', 'visibility']
    : ['profiles', 'regression_candidate', 'stable_repository_id', 'visibility'];
  if (JSON.stringify(targetKeys) !== JSON.stringify(expectedTargetKeys)) {
    fail(`Unexpected target record keys: ${target}`);
  }
  if (entry.visibility !== 'public') fail(`Non-public target: ${target}`);
  if (!/^[1-9][0-9]*$/.test(String(entry.stable_repository_id))) {
    fail(`Invalid stable repository ID: ${target}`);
  }
  if (stableRepositoryIds.has(String(entry.stable_repository_id))) {
    fail(`Duplicate stable repository ID: ${entry.stable_repository_id}`);
  }
  stableRepositoryIds.add(String(entry.stable_repository_id));
  if (!Array.isArray(entry.profiles) || entry.profiles.length === 0) {
    fail(`Target has no profiles: ${target}`);
  }
  if (new Set(entry.profiles).size !== entry.profiles.length ||
      entry.profiles.some((profile) => typeof profile !== 'string')) {
    fail(`Invalid target profile list: ${target}`);
  }
  for (const profile of entry.profiles) {
    if (!Object.hasOwn(config.profiles, profile)) {
      fail(`Unknown profile ${profile} for ${target}`);
    }
  }
  if (entry.regression_candidate) {
    const candidate = entry.regression_candidate;
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object' ||
        JSON.stringify(Object.keys(candidate).sort()) !==
          JSON.stringify(['profile', 'sha'])) {
      fail(`Invalid regression candidate record: ${target}`);
    }
    if (!/^[0-9a-f]{40}$/.test(candidate.sha)) {
      fail(`Invalid regression SHA: ${target}`);
    }
    if (!entry.profiles.includes(candidate.profile)) {
      fail(`Regression profile is not authorized: ${target}`);
    }
    if (config.profiles[candidate.profile].family !== 'python') {
      fail(`Only isolated Python regression candidates are supported: ${target}`);
    }
    regressionJobCount +=
      config.profiles[candidate.profile].runtime.python_versions.length;
  }
}
if (regressionJobCount > MAX_REGRESSION_JOBS) {
  fail(`Regression matrix may contain at most ${MAX_REGRESSION_JOBS} jobs`);
}

const canary = config.canary;
if (!canary || Array.isArray(canary) || typeof canary !== 'object' ||
    !isDeepStrictEqual(
      Object.keys(canary).sort(),
      ['lead_provider', 'profile', 'sha', 'target'],
    )) {
  fail('Relay canary must be one exact data-only record');
}
if (!targetPattern.test(canary.target) ||
    !/^[0-9a-f]{40}$/.test(canary.sha) ||
    !profilePattern.test(canary.profile) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(canary.lead_provider)) {
  fail('Relay canary contains an invalid target, SHA, profile, or provenance label');
}
const canaryTarget = config.targets[canary.target];
if (!canaryTarget || canaryTarget.visibility !== 'public' ||
    !canaryTarget.profiles.includes(canary.profile)) {
  fail('Relay canary is not an allowlisted public target/profile pair');
}

const nestedMappingEntries = (entries, parent, end, context) => {
  const nextPeer = entries.find(
    (entry) => entry.line > parent.line && entry.line < end &&
      entry.indent <= parent.indent,
  );
  const mappingEnd = nextPeer?.line ?? end;
  const children = entries.filter(
    (entry) => entry.line > parent.line && entry.line < mappingEnd &&
      entry.indent === parent.indent + 2 && !entry.listItem,
  );
  duplicateKeys(children, context);
  return children;
};

const containingJob = (model, line) => [...model.jobs.values()].find(
  (job) => line > job.start && line < job.end,
);

const permissionGrants = [];
for (const [file, model] of Object.entries(workflowModels)) {
  const secretKeys = model.entries.filter((entry) => entry.key === 'secrets');
  if (secretKeys.length > 0) {
    fail(`Workflow may not declare or pass secrets: ${file}:${secretKeys[0].lineNumber}`);
  }
  const expressions = workflows[file].match(/\$\{\{[\s\S]*?\}\}/gu) ?? [];
  if (expressions.some((expression) => /\bsecrets\b/u.test(expression))) {
    fail(`Workflow may not reference the GitHub secrets context: ${file}`);
  }

  for (const permission of model.entries.filter(
    (entry) => entry.key === 'permissions',
  )) {
    const job = containingJob(model, permission.line);
    if ((job && permission.indent !== 4) || (!job && permission.indent !== 0)) {
      fail(`Permissions must be declared only at workflow or job scope: ${file}:${permission.lineNumber}`);
    }
    let grants;
    if (permission.value === '') {
      const end = job?.end ?? model.lines.length;
      grants = nestedMappingEntries(
        model.entries,
        permission,
        end,
        `${file} permissions at line ${permission.lineNumber}`,
      ).map((entry) => ({
        key: entry.key,
        scalar: unquoteYamlScalar(
          entry.value,
          `${file}:${entry.lineNumber} permission`,
        ),
      }));
    } else if (permission.value.trim().startsWith('{')) {
      grants = parseFlowMap(
        permission.value,
        `${file}:${permission.lineNumber} permissions`,
      );
      duplicateKeys(grants, `${file}:${permission.lineNumber} permissions`);
    } else {
      const scalar = unquoteYamlScalar(
        permission.value,
        `${file}:${permission.lineNumber} permissions`,
      );
      if (scalar === 'write-all') {
        fail(`Workflow may not grant write-all permissions: ${file}:${permission.lineNumber}`);
      }
      if (scalar !== 'read-all') {
        fail(`Unsupported permission syntax: ${file}:${permission.lineNumber}`);
      }
      grants = [{ key: '*', scalar: 'read' }];
    }
    for (const grant of grants) {
      if (!['read', 'write', 'none'].includes(grant.scalar)) {
        fail(`Invalid permission ${grant.key}: ${grant.scalar} in ${file}`);
      }
      permissionGrants.push({
        file,
        job: job?.id ?? null,
        key: grant.key,
        scalar: grant.scalar,
      });
    }
  }
}

const relayTopPermissions = relayModel.entries.find(
  (entry) => entry.indent === 0 && entry.key === 'permissions',
);
if (!relayTopPermissions || relayTopPermissions.value.replaceAll(' ', '') !== '{}') {
  fail('The relay workflow must default to zero permissions');
}
const writePermissions = permissionGrants.filter(
  (permission) => permission.scalar === 'write',
);
if (writePermissions.length !== 1 ||
    writePermissions[0].file !== 'relay-process-environment.yml' ||
    writePermissions[0].job !== 'receipt' ||
    writePermissions[0].key !== 'contents') {
  fail('Only the isolated receipt job may receive one contents: write grant');
}
const receiptPermissionGrants = permissionGrants.filter(
  (permission) => permission.file === 'relay-process-environment.yml' &&
    permission.job === 'receipt',
);
if (receiptPermissionGrants.length !== 1 ||
    receiptPermissionGrants[0].key !== 'contents' ||
    receiptPermissionGrants[0].scalar !== 'write') {
  fail('The receipt job permission map must be exactly contents: write');
}

if (fs.existsSync('receipts')) {
  fail('Receipt data must not be tracked on the trusted branch');
}

const receiptJob = relayModel.jobs.get('receipt');
if (!receiptJob) fail('Missing receipt job');
if (!/else if \(family === 'python'\) \{\s*allPassed =\s*process\.env\.PYTHON_DISPATCH_RESULT === 'success' &&\s*regressionsPassed;\s*\}/u
    .test(receiptJob.source)) {
  fail('Python receipt aggregation must include trust-root regressions');
}
const receiptSteps = extractSteps(relayModel, receiptJob);
const checkoutSteps = [];
for (const step of receiptSteps) {
  const uses = step.directEntries.find((entry) => entry.key === 'uses');
  if (!uses) continue;
  const action = unquoteYamlScalar(
    uses.value,
    `relay receipt action at line ${uses.lineNumber}`,
  );
  if (!action.startsWith('actions/checkout@')) continue;
  const withEntry = step.directEntries.find((entry) => entry.key === 'with');
  if (!withEntry || withEntry.value !== '') {
    fail('Receipt checkout must use a block with mapping');
  }
  const withEntries = nestedMappingEntries(
    step.entries,
    withEntry,
    step.end,
    `receipt checkout with mapping at line ${withEntry.lineNumber}`,
  );
  checkoutSteps.push({
    step,
    values: new Map(withEntries.map((entry) => [
      entry.key,
      unquoteYamlScalar(
        entry.value,
        `receipt checkout ${entry.key} at line ${entry.lineNumber}`,
      ),
    ])),
  });
}
const expectedLedgerCheckout = new Map([
  ['ref', 'receipts'],
  ['path', 'ledger'],
  ['fetch-depth', '1'],
  ['persist-credentials', 'true'],
]);
const ledgerCheckouts = checkoutSteps.filter(({ values }) =>
  values.size === expectedLedgerCheckout.size &&
  [...expectedLedgerCheckout].every(([key, value]) => values.get(key) === value),
);
const receiptRefs = relayModel.entries.filter((entry) =>
  entry.key === 'ref' &&
  unquoteYamlScalar(entry.value, `ref at line ${entry.lineNumber}`) === 'receipts',
);
if (ledgerCheckouts.length !== 1 || receiptRefs.length !== 1 ||
    receiptRefs[0].line < ledgerCheckouts[0].step.start ||
    receiptRefs[0].line >= ledgerCheckouts[0].step.end) {
  fail('The receipts ref must be bound to the isolated ledger checkout');
}

const pushCommands = findGitCommands(workflow).filter((command) =>
  commandHasSubcommand(command, 'push'),
);
const expectedPush = [
  'git', '-C', 'ledger', 'push', 'origin', 'HEAD:receipts',
];
if (pushCommands.length !== 1 ||
    JSON.stringify(pushCommands[0].tokens) !== JSON.stringify(expectedPush)) {
  fail('The receipt push must be the only Git push command');
}

const normalizedExecutableLines = (source) => normalizeShellContinuations(source)
  .split('\n')
  .map((line) => stripYamlComment(line).trim().replace(/\s+/gu, ' '))
  .filter(Boolean);

const directStepValue = (step, key, context) => {
  const entry = step.directEntries.find((candidate) => candidate.key === key);
  return entry ? unquoteYamlScalar(entry.value, context) : null;
};

const assertExecutionCheckout = (jobId, shell) => {
  const job = relayModel.jobs.get(jobId);
  if (!job) fail(`Missing execution job: ${jobId}`);
  const steps = extractSteps(relayModel, job);
  const fetchSteps = steps.filter((step) => findGitCommands(step.source)
    .some((command) => commandHasSubcommand(command, 'fetch')));
  if (fetchSteps.length !== 1) {
    fail(`Execution job ${jobId} must contain exactly one exact-SHA fetch step`);
  }
  const step = fetchSteps[0];
  if (directStepValue(step, 'shell', `${jobId} fetch shell`) !== shell ||
      directStepValue(step, 'if', `${jobId} fetch condition`) !== null ||
      directStepValue(step, 'continue-on-error', `${jobId} fetch error policy`) !== null) {
    fail(`Execution job ${jobId} fetch step must run unconditionally in ${shell}`);
  }
  const fetchCommands = findGitCommands(step.source).filter((command) =>
    commandHasSubcommand(command, 'fetch'));
  const expectedFetch = shell === 'pwsh'
    ? [
      'git', '-C', '$source.Directory', '-c', 'credential.helper=', '-c',
      'protocol.version=2', 'fetch', '--no-tags', '--depth=1', 'origin',
      '$source.Revision',
    ]
    : [
      'git', '-C', '$directory', '-c', 'credential.helper=', '-c',
      'protocol.version=2', 'fetch', '--no-tags', '--depth=1', 'origin',
      '$revision',
    ];
  if (fetchCommands.length !== 1 ||
      JSON.stringify(fetchCommands[0].tokens) !== JSON.stringify(expectedFetch)) {
    fail(`Execution job ${jobId} must fetch only the authorized exact revision`);
  }
  const lines = new Set(normalizedExecutableLines(step.source));
  if (shell === 'pwsh') {
    const required = [
      "$sources = @(",
      "@{ Directory = 'relay-trust'; Repository = $env:GITHUB_REPOSITORY; Revision = $env:RELAY_SHA },",
      "@{ Directory = 'target'; Repository = $env:TARGET_REPO; Revision = $env:TARGET_SHA }",
      'git -C $source.Directory checkout --detach FETCH_HEAD',
      '$actual = git -C $source.Directory rev-parse HEAD',
      'if ($actual -cne $source.Revision) {',
      'throw "Fetched $actual instead of $($source.Revision)"',
    ];
    if (required.some((line) => !lines.has(line))) {
      fail(`Execution job ${jobId} must verify the fetched Windows revision`);
    }
  } else {
    const required = [
      'for spec in "relay-trust|$GITHUB_REPOSITORY|$RELAY_SHA" "target|$TARGET_REPO|$TARGET_SHA"',
      "IFS='|' read -r directory repository revision <<< \"$spec\"",
      'git -C "$directory" checkout --detach FETCH_HEAD',
      '[[ "$(git -C "$directory" rev-parse HEAD)" == "$revision" ]]',
    ];
    if (required.some((line) => !lines.has(line))) {
      fail(`Execution job ${jobId} must verify both fetched exact revisions`);
    }
  }
};

assertExecutionCheckout('posix', 'bash');
assertExecutionCheckout('windows', 'pwsh');
assertExecutionCheckout('python_dispatch', 'bash');
assertExecutionCheckout('python_regression', 'bash');

const prepareRegressionJob = relayModel.jobs.get('prepare_regression');
const prepareMatrixSteps = extractSteps(relayModel, prepareRegressionJob).filter(
  (step) => directStepValue(step, 'id', 'prepare_regression matrix step') === 'matrix',
);
const sourceDigest = (source) => createHash('sha256').update(source).digest('hex');
const expectedPrepareMatrixDigest =
  '92566ff6fd9ca33427c637790135e0001f2ea955668a2f0a35deb9068d698355';
if (prepareMatrixSteps.length !== 1 ||
    sourceDigest(prepareMatrixSteps[0].source) !== expectedPrepareMatrixDigest) {
  fail('prepare_regression registry accounting anchors changed');
}

const pythonRegressionJob = relayModel.jobs.get('python_regression');
const regressionIdentitySteps = extractSteps(relayModel, pythonRegressionJob).filter(
  (step) => directStepValue(
    step,
    'name',
    'python_regression live identity step',
  ) === 'Re-authorize live identity and fetch both exact revisions anonymously',
);
const expectedRegressionIdentityDigest =
  '921e3e0648b68cae614a65a3bb481f5c7dd2e0017fdf37bf2a798b3de348bff6';
if (regressionIdentitySteps.length !== 1 ||
    sourceDigest(regressionIdentitySteps[0].source) !==
      expectedRegressionIdentityDigest) {
  fail('python_regression canonical live repository identity anchor changed');
}

const requiredExecutableLines = [
  '- ".github/workflows/relay-policy.yml"',
  '- "scripts/**"',
  'relay-${{ github.event_name == \'push\' && github.sha || format(\'{0}-{1}-{2}\', inputs.target, inputs.profile, inputs.sha) }}',
  'cancel-in-progress: ${{ github.event_name != \'push\' }}',
  '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]',
  'TARGET_REPO: ${{ steps.resolve.outputs.target }}',
  'TARGET_SHA: ${{ steps.resolve.outputs.sha }}',
  'TARGET_PROFILE: ${{ steps.resolve.outputs.profile }}',
  'LEAD_PROVIDER: ${{ steps.resolve.outputs.lead_provider }}',
  "const canary = config.canary;",
  'python_versions: ${{ steps.allow.outputs.python_versions }}',
  'node_version: ${{ steps.allow.outputs.node_version }}',
  'runtime_json: ${{ steps.allow.outputs.runtime_json }}',
  'python-version: ${{ fromJSON(needs.authorize.outputs.python_versions) }}',
  'matrix: ${{ fromJSON(needs.prepare_regression.outputs.matrix) }}',
  'const runtime = implementation.runtime;',
  'python_version: pythonVersion,',
  "node_version: runtime.node_version ?? ''",
  'TARGET_RUNTIME_JSON: ${{ needs.authorize.outputs.runtime_json }}',
  'REGRESSION_MATRIX_JSON: ${{ needs.prepare_regression.outputs.matrix }}',
  'runtime',
  'exact_regression_matrix: regressionMatrix',
  'relative_receipt="${receipt_file#ledger/}"',
  'sha256sum "$relative_receipt"',
  'sha256sum -c "$relative_receipt.sha256"',
];
const executableLines = new Set(
  workflow.split('\n').map((line) => line.trim()),
);
for (const line of requiredExecutableLines) {
  if (!executableLines.has(line)) {
    fail(`Missing trust-boundary command: ${line}`);
  }
}
if (relayModel.entries.some((entry) => entry.key === 'default')) {
  fail('Workflow dispatch inputs must be explicit and have no defaults');
}
if (/inputs\.(?:target|sha|profile|lead_provider)\s*\|\|/u.test(workflow)) {
  fail('Relay inputs may not bypass the data-only canary resolver');
}
if (workflow.includes('sha256sum "$receipt_file" > "$receipt_file.sha256"')) {
  fail('Receipt checksums must record branch-relative paths');
}

const policyJobs = [...policyModel.jobs.keys()];
if (JSON.stringify(policyJobs) !== JSON.stringify(['policy'])) {
  fail('Relay policy workflow must define only the policy job');
}
const policyJobName = policyModel.jobs.get('policy').jobLevelEntries.find(
  (entry) => entry.key === 'name',
);
if (!policyJobName || unquoteYamlScalar(
  policyJobName.value,
  'relay policy job name',
) !== "${{ github.event_name == 'pull_request_target' && 'Relay trust policy' || 'Relay trust policy self-check' }}") {
  fail('Only pull_request_target may emit the required Relay trust policy context');
}
const policyRunCommands = extractSteps(
  policyModel,
  policyModel.jobs.get('policy'),
).flatMap((step) => step.directEntries
  .filter((entry) => entry.key === 'run')
  .map((entry) => unquoteYamlScalar(entry.value, `policy run at ${entry.lineNumber}`)));
const expectedPolicyRunCommands = [
  '|',
  'node trusted/scripts/verify-policy.mjs --candidate-root "$CANDIDATE_ROOT" --base-root trusted',
  'node trusted/scripts/test-policy.mjs --base-root trusted',
];
if (JSON.stringify(policyRunCommands) !== JSON.stringify(expectedPolicyRunCommands)) {
  fail('Relay policy workflow must run only the verifier and its regressions');
}
const requiredPolicyLines = [
  'pull_request_target:',
  'types: [opened, reopened, synchronize, ready_for_review, edited]',
  'push:',
  'workflow_dispatch:',
  "ref: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.sha }}",
  'if: github.event_name == \'pull_request_target\'',
  'git -C candidate-repository init --bare',
  'GIT_TERMINAL_PROMPT=0 git -C candidate-repository \\',
  'fetch --no-tags --filter=blob:none --depth=1 origin "$HEAD_SHA"',
  '[[ "$(git -C candidate-repository rev-parse FETCH_HEAD)" == "$HEAD_SHA" ]]',
  '.github/workflows',
  '.github/workflows/relay-policy.yml',
  '.github/workflows/relay-process-environment.yml',
  'scripts/verify-policy.mjs',
  'scripts/test-policy.mjs',
  'relay',
  'profiles',
  'if [[ -z "$base_entry" || "$head_entry" != "$base_entry" ]]; then',
  'attribute_paths=(',
  '.gitattributes',
  '.github/.gitattributes',
  'config/.gitattributes',
  'scripts/.gitattributes',
  'if [[ "$head_entry" != "$base_entry" ]]; then',
  'contents_auth=()',
  'if [[ "$HEAD_REPOSITORY" == "$BASE_REPOSITORY" ]]; then',
  'contents_auth=(--header "Authorization: Bearer $GITHUB_TOKEN")',
  "--header 'Accept: application/vnd.github.object+json' \\",
  '"${contents_auth[@]}" \\',
  '"$GITHUB_API_URL/repos/$HEAD_REPOSITORY/contents/config/targets.json?ref=$HEAD_SHA" \\',
  "metadata.size > 2 * 1024 * 1024) {",
  'config_entry="$(git -C candidate-repository \\',
  '[[ "$config_mode" == 100644 ]]',
  '[[ "$config_oid" == "$config_api_oid" ]]',
  'cp -a trusted/.github trusted/config trusted/profiles trusted/scripts candidate/',
  'GIT_TERMINAL_PROMPT=0 git -C candidate-repository \\',
  '-c credential.helper= -c protocol.version=2 cat-file blob \\',
  '"$HEAD_SHA:config/targets.json" > candidate/config/targets.json',
  '[[ "$(wc -c < candidate/config/targets.json)" == "$config_size" ]]',
  '../candidate/config/targets.json)" == "$config_oid" ]]',
];
const policyLines = new Set(policyWorkflow.split('\n').map((line) => line.trim()));
for (const line of requiredPolicyLines) {
  if (!policyLines.has(line)) {
    fail(`Missing base-anchored policy command: ${line}`);
  }
}
if (policyLines.has('pull_request:')) {
  fail('Relay policy must not execute candidate-controlled pull_request workflow code');
}

for (const [file, model] of Object.entries(workflowModels)) {
  for (const entry of model.entries.filter((candidate) => candidate.key === 'uses')) {
    const action = unquoteYamlScalar(entry.value, `${file}:${entry.lineNumber} action`);
    if (action === '' || /\s/u.test(action)) {
      fail(`Malformed action reference in ${file}:${entry.lineNumber}`);
    }
    if (!action.startsWith('./') && !/@[0-9a-f]{40}$/.test(action)) {
      fail(`External action is not pinned to a full SHA in ${file}: ${action}`);
    }
  }
}

const expectedRelayJobs = [
  'authorize',
  'posix',
  'windows',
  'prepare_regression',
  'python_dispatch',
  'python_regression',
  'receipt',
];
if (!isDeepStrictEqual([...relayModel.jobs.keys()], expectedRelayJobs)) {
  fail('Relay workflow job allowlist changed');
}

const actionSignatures = [];
for (const [file, model] of Object.entries(workflowModels)) {
  for (const entry of model.entries.filter((candidate) => candidate.key === 'uses')) {
    actionSignatures.push(
      `${file}:${containingJob(model, entry.line)?.id ?? 'workflow'}:` +
        unquoteYamlScalar(entry.value, `${file}:${entry.lineNumber} action`),
    );
  }
}
const expectedActionSignatures = [
  'relay-policy.yml:policy:actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'relay-process-environment.yml:authorize:actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'relay-process-environment.yml:posix:actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'relay-process-environment.yml:windows:actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'relay-process-environment.yml:prepare_regression:actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'relay-process-environment.yml:python_dispatch:actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
  'relay-process-environment.yml:python_dispatch:actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'relay-process-environment.yml:python_regression:actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
  'relay-process-environment.yml:python_regression:actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'relay-process-environment.yml:receipt:actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'relay-process-environment.yml:receipt:actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
];
if (!isDeepStrictEqual(actionSignatures, expectedActionSignatures)) {
  fail('Workflow action allowlist changed');
}

const permissionSignatures = permissionGrants.map((permission) =>
  `${permission.file}:${permission.job ?? 'workflow'}:${permission.key}:${permission.scalar}`,
);
const expectedPermissionSignatures = [
  'relay-policy.yml:workflow:contents:read',
  'relay-process-environment.yml:authorize:contents:read',
  'relay-process-environment.yml:prepare_regression:contents:read',
  'relay-process-environment.yml:receipt:contents:write',
];
if (!isDeepStrictEqual(permissionSignatures, expectedPermissionSignatures)) {
  fail('Workflow permission allowlist changed');
}

const assertProfileExecutionStep = (jobId, expectedName, shell, command) => {
  const job = relayModel.jobs.get(jobId);
  const matches = extractSteps(relayModel, job).filter((step) =>
    directStepValue(step, 'run', `${jobId} profile run`) === command,
  );
  if (matches.length !== 1) {
    fail(`Execution job ${jobId} must invoke exactly one trusted profile`);
  }
  const step = matches[0];
  if (directStepValue(step, 'name', `${jobId} profile name`) !== expectedName ||
      directStepValue(step, 'shell', `${jobId} profile shell`) !== shell ||
      directStepValue(step, 'working-directory', `${jobId} profile directory`) !== 'target' ||
      directStepValue(step, 'if', `${jobId} profile condition`) !== null ||
      directStepValue(step, 'continue-on-error', `${jobId} profile error policy`) !== null) {
    fail(`Execution job ${jobId} profile step changed`);
  }
};
assertProfileExecutionStep(
  'posix',
  'Execute relay-owned POSIX profile',
  'bash',
  'bash "../relay-trust/profiles/$TARGET_PROFILE.sh"',
);
assertProfileExecutionStep(
  'windows',
  'Execute relay-owned Windows profile',
  'pwsh',
  '& "..\\relay-trust\\profiles\\$env:TARGET_PROFILE.ps1"',
);
for (const jobId of ['python_dispatch', 'python_regression']) {
  assertProfileExecutionStep(
    jobId,
    'Execute relay-owned Python profile',
    'bash',
    'bash "../relay-trust/profiles/$TARGET_PROFILE.sh"',
  );
}

const stepWithValues = (step, context) => {
  const withEntry = step.directEntries.find((entry) => entry.key === 'with');
  if (!withEntry || withEntry.value !== '') {
    fail(`${context} must use one block with mapping`);
  }
  const values = nestedMappingEntries(
    step.entries,
    withEntry,
    step.end,
    `${context} with mapping at line ${withEntry.lineNumber}`,
  );
  return new Map(values.map((entry) => [
    entry.key,
    unquoteYamlScalar(entry.value, `${context} ${entry.key}`),
  ]));
};

const assertRuntimeSetupSteps = (jobId, pythonExpression, nodeExpression, nodeIf) => {
  const job = relayModel.jobs.get(jobId);
  const steps = extractSteps(relayModel, job);
  const setupPythonSteps = steps.filter((step) =>
    directStepValue(step, 'uses', `${jobId} setup-python action`) ===
      'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
  );
  if (setupPythonSteps.length !== 1) {
    fail(`Execution job ${jobId} must set up one exact Python runtime`);
  }
  const pythonStep = setupPythonSteps[0];
  const pythonValues = stepWithValues(pythonStep, `${jobId} setup-python`);
  if (directStepValue(pythonStep, 'if', `${jobId} setup-python condition`) !== null ||
      directStepValue(pythonStep, 'continue-on-error', `${jobId} setup-python error policy`) !== null ||
      pythonValues.size !== 1 || pythonValues.get('python-version') !== pythonExpression) {
    fail(`Execution job ${jobId} Python runtime setup changed`);
  }

  const setupNodeSteps = steps.filter((step) =>
    directStepValue(step, 'uses', `${jobId} setup-node action`) ===
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  );
  if (setupNodeSteps.length !== 1) {
    fail(`Execution job ${jobId} must set up one exact optional Node runtime`);
  }
  const nodeStep = setupNodeSteps[0];
  const nodeValues = stepWithValues(nodeStep, `${jobId} setup-node`);
  const expectedNodeValues = new Map([
    ['node-version', nodeExpression],
    ['check-latest', 'false'],
    ['package-manager-cache', 'false'],
  ]);
  if (directStepValue(nodeStep, 'name', `${jobId} setup-node name`) !==
        'Set up exact optional Node runtime' ||
      directStepValue(nodeStep, 'if', `${jobId} setup-node condition`) !== nodeIf ||
      directStepValue(nodeStep, 'continue-on-error', `${jobId} setup-node error policy`) !== null ||
      nodeValues.size !== expectedNodeValues.size ||
      [...expectedNodeValues].some(([key, value]) => nodeValues.get(key) !== value)) {
    fail(`Execution job ${jobId} Node runtime setup changed`);
  }
};

assertRuntimeSetupSteps(
  'python_dispatch',
  '${{ matrix.python-version }}',
  '${{ needs.authorize.outputs.node_version }}',
  "needs.authorize.outputs.node_version != ''",
);
assertRuntimeSetupSteps(
  'python_regression',
  '${{ matrix.python_version }}',
  '${{ matrix.node_version }}',
  "matrix.node_version != ''",
);

let baseConfig;
try {
  baseConfig = JSON.parse(
    fs.readFileSync(path.join(baseRoot, 'config', 'targets.json'), 'utf8'),
  );
} catch {
  fail('Trusted base target registry is not valid JSON');
}
if (!isDeepStrictEqual(config.schema, baseConfig.schema) ||
    !isDeepStrictEqual(config.policy, baseConfig.policy) ||
    !isDeepStrictEqual(config.profiles, baseConfig.profiles)) {
  fail('Candidate may change only target records and canary fields; schema, policy, and profiles are frozen');
}

for (const relativePath of frozenExecutableFiles) {
  const trusted = inspectRegularFile(baseRoot, relativePath);
  const candidate = inspectRegularFile(candidateRoot, relativePath);
  if (trusted.mode !== candidate.mode || !trusted.bytes.equals(candidate.bytes)) {
    fail(`Frozen executable trust root changed: ${relativePath}`);
  }
}
for (const relativePath of frozenAttributeFiles) {
  const trusted = inspectOptionalRegularFile(baseRoot, relativePath);
  const candidate = inspectOptionalRegularFile(candidateRoot, relativePath);
  if ((trusted === null) !== (candidate === null) ||
      (trusted !== null && (
        trusted.mode !== candidate.mode || !trusted.bytes.equals(candidate.bytes)
      ))) {
    fail(`Git attributes governing the trust root changed: ${relativePath}`);
  }
}
const trustedProfiles = collectProfileFiles(baseRoot);
const candidateProfiles = collectProfileFiles(candidateRoot);
if (!isDeepStrictEqual(candidateProfiles, trustedProfiles)) {
  fail('Frozen executable trust root changed: profiles');
}
for (const relativePath of trustedProfiles) {
  const trusted = inspectRegularFile(baseRoot, relativePath);
  const candidate = inspectRegularFile(candidateRoot, relativePath);
  if (trusted.mode !== candidate.mode || !trusted.bytes.equals(candidate.bytes)) {
    fail(`Frozen executable trust root changed: ${relativePath}`);
  }
}

console.log(
  `verified ${Object.keys(config.targets).length} targets, ` +
    `${Object.keys(config.profiles).length} profiles, zero secrets, ` +
    'pinned actions, exact SHAs, and isolated receipt writes',
);
