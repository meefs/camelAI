#!/usr/bin/env node
/**
 * create-notebook-worker - Scaffold a static notebook-rendering worker
 *
 * Usage:
 *   create-notebook-worker <project-name> --notebook <path> [options]
 */

import { spawnSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync, cpSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, 'templates', 'notebook-static');

const OPTIONS = {
  style: ['vega', 'nova', 'maia', 'lyra', 'mira'],
  baseColor: ['neutral', 'zinc', 'gray', 'stone'],
  theme: ['neutral', 'amber', 'blue', 'cyan', 'emerald', 'fuchsia', 'green', 'indigo', 'lime', 'orange', 'pink', 'purple', 'red', 'rose', 'sky', 'teal', 'violet', 'yellow', 'zinc', 'gray', 'stone'],
  font: ['inter', 'noto-sans', 'nunito-sans', 'figtree'],
  radius: ['default', 'none', 'small', 'medium', 'large'],
  menuColor: ['default', 'inverted'],
  menuAccent: ['subtle', 'bold'],
};

const DEFAULTS = {
  style: 'mira',
  baseColor: 'neutral',
  theme: 'neutral',
  font: 'inter',
  radius: 'default',
  menuColor: 'default',
  menuAccent: 'subtle',
};

const FONT_CONFIG = {
  'inter': { package: '@fontsource-variable/inter', fontFamily: "'Inter Variable', sans-serif" },
  'noto-sans': { package: '@fontsource-variable/noto-sans', fontFamily: "'Noto Sans Variable', sans-serif" },
  'nunito-sans': { package: '@fontsource-variable/nunito-sans', fontFamily: "'Nunito Sans Variable', sans-serif" },
  'figtree': { package: '@fontsource-variable/figtree', fontFamily: "'Figtree Variable', sans-serif" },
};

function showHelp() {
  console.log(`
create-notebook-worker - Scaffold a static notebook-rendering worker

Usage:
  create-notebook-worker <project-name> --notebook <path> [options]

Required:
  --notebook, -n <path>   Path to source .ipynb file

Options:
  --style <style>         UI style [default: ${DEFAULTS.style}]
                          Values: ${OPTIONS.style.join(', ')}

  --theme <color>         Theme color [default: ${DEFAULTS.theme}]
                          Values: ${OPTIONS.theme.join(', ')}

  --base-color <color>    Base gray color [default: ${DEFAULTS.baseColor}]
                          Values: ${OPTIONS.baseColor.join(', ')}
                          Note: When theme is a gray (zinc/gray/stone), base-color must match

  --font <font>           Font family [default: ${DEFAULTS.font}]
                          Values: ${OPTIONS.font.join(', ')}

  --radius <size>         Border radius [default: ${DEFAULTS.radius}]
                          Values: ${OPTIONS.radius.join(', ')}

  --menu-color <type>     Menu color style [default: ${DEFAULTS.menuColor}]
                          Values: ${OPTIONS.menuColor.join(', ')}

  --menu-accent <type>    Menu accent style [default: ${DEFAULTS.menuAccent}]
                          Values: ${OPTIONS.menuAccent.join(', ')}

  --help                  Show this help message

Examples:
  create-notebook-worker sales-notebook --notebook ./analysis.ipynb
  create-notebook-worker sales-notebook --notebook /mnt/user-uploads/report.ipynb --style nova --theme blue
`);
}

function resolveNotebookPath(inputPath) {
  if (inputPath.startsWith('~/')) {
    const home = process.env.HOME || '';
    return resolve(home, inputPath.slice(2));
  }

  return resolve(process.cwd(), inputPath);
}

function parseArgs(args) {
  const result = {
    projectName: null,
    notebookPath: null,
    options: { ...DEFAULTS },
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if ((arg === '--notebook' || arg === '-n') && args[i + 1]) {
      result.notebookPath = args[++i];
    } else if (arg === '--style' && args[i + 1]) {
      result.options.style = args[++i];
    } else if (arg === '--theme' && args[i + 1]) {
      result.options.theme = args[++i];
    } else if (arg === '--base-color' && args[i + 1]) {
      result.options.baseColor = args[++i];
    } else if (arg === '--font' && args[i + 1]) {
      result.options.font = args[++i];
    } else if (arg === '--radius' && args[i + 1]) {
      result.options.radius = args[++i];
    } else if (arg === '--menu-color' && args[i + 1]) {
      result.options.menuColor = args[++i];
    } else if (arg === '--menu-accent' && args[i + 1]) {
      result.options.menuAccent = args[++i];
    } else if (!arg.startsWith('-') && !result.projectName) {
      result.projectName = arg;
    }
  }

  return result;
}

function validateOptions(options) {
  const errors = [];

  for (const [key, validValues] of Object.entries(OPTIONS)) {
    if (options[key] && !validValues.includes(options[key])) {
      errors.push(`Invalid ${key}: "${options[key]}". Valid values: ${validValues.join(', ')}`);
    }
  }

  const grayThemes = ['zinc', 'gray', 'stone'];
  if (grayThemes.includes(options.theme) && options.baseColor !== options.theme) {
    errors.push(`When theme is "${options.theme}", base-color must also be "${options.theme}"`);
  }

  return errors;
}

function buildPresetUrl(options) {
  const params = new URLSearchParams({
    base: 'radix',
    style: options.style,
    baseColor: options.baseColor,
    theme: options.theme,
    iconLibrary: 'lucide',
    font: options.font,
    radius: options.radius,
    menuColor: options.menuColor,
    menuAccent: options.menuAccent,
    template: 'vite',
  });
  return `https://ui.shadcn.com/init?${params.toString()}`;
}

function createComponentsJson(projectDir, options) {
  const componentsJson = {
    '$schema': 'https://ui.shadcn.com/schema.json',
    style: `radix-${options.style}`,
    rsc: false,
    tsx: true,
    tailwind: {
      config: '',
      css: 'src/styles.css',
      baseColor: options.baseColor,
      cssVariables: true,
      prefix: '',
    },
    iconLibrary: 'lucide',
    aliases: {
      components: '@/components',
      utils: '@/lib/utils',
      ui: '@/components/ui',
      lib: '@/lib',
      hooks: '@/hooks',
    },
    menuColor: options.menuColor,
    menuAccent: options.menuAccent,
    registries: {},
  };

  writeFileSync(join(projectDir, 'components.json'), JSON.stringify(componentsJson, null, 2) + '\n');
}

async function fetchPresetConfig(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch preset config: ${response.status}`);
  }
  return response.json();
}

function generateCssFromPreset(preset, options) {
  const fontConfig = FONT_CONFIG[options.font] || FONT_CONFIG.inter;
  const { light, dark } = preset.cssVars;

  const lightVars = Object.entries(light)
    .map(([key, value]) => `    --${key}: ${value};`)
    .join('\n');

  const darkVars = Object.entries(dark)
    .map(([key, value]) => `    --${key}: ${value};`)
    .join('\n');

  const themeColors = Object.keys(light)
    .filter((key) => key !== 'radius')
    .map((key) => `    --color-${key}: var(--${key});`)
    .join('\n');

  const templatePath = join(TEMPLATE_DIR, 'src', 'styles.css.template');
  const template = readFileSync(templatePath, 'utf-8');

  return template
    .replace('{{FONT_IMPORT}}', fontConfig.package)
    .replace('{{FONT_FAMILY}}', fontConfig.fontFamily)
    .replace('{{LIGHT_VARS}}', lightVars)
    .replace('{{DARK_VARS}}', darkVars)
    .replace('{{THEME_COLORS}}', themeColors);
}

function copyTemplate(projectDir) {
  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`Template directory not found: ${TEMPLATE_DIR}`);
  }

  cpSync(TEMPLATE_DIR, projectDir, { recursive: true });
}

function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function createProject(projectName, notebookPath, options) {
  const totalStart = Date.now();
  const projectDir = join(process.cwd(), projectName);
  const sourceNotebookPath = resolveNotebookPath(notebookPath);

  if (existsSync(projectDir)) {
    console.error(`Error: Directory '${projectName}' already exists`);
    process.exit(1);
  }

  if (!existsSync(sourceNotebookPath)) {
    console.error(`Error: Notebook file not found: ${sourceNotebookPath}`);
    process.exit(1);
  }

  if (!statSync(sourceNotebookPath).isFile()) {
    console.error(`Error: Notebook path is not a file: ${sourceNotebookPath}`);
    process.exit(1);
  }

  console.log(`Creating notebook worker project: ${projectName}`);
  console.log(`Notebook: ${sourceNotebookPath}`);
  console.log(`Style: ${options.style}, Theme: ${options.theme}, Font: ${options.font}`);
  console.log('');

  console.log('Step 1/6: Copying template...');
  let stepStart = Date.now();
  try {
    copyTemplate(projectDir);
    console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);
  } catch (error) {
    console.error('Failed to copy template:', error.message);
    process.exit(1);
  }

  console.log('\nStep 2/6: Fetching shadcn styling configuration...');
  stepStart = Date.now();
  const presetUrl = buildPresetUrl(options);
  let presetConfig;

  try {
    presetConfig = await fetchPresetConfig(presetUrl);
    console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);
  } catch (error) {
    console.error('Failed to fetch shadcn configuration:', error.message);
    process.exit(1);
  }

  console.log('\nStep 3/6: Applying shadcn styling...');
  stepStart = Date.now();
  const targetCssPath = join(projectDir, 'src', 'styles.css');
  const generatedCss = generateCssFromPreset(presetConfig, options);
  writeFileSync(targetCssPath, generatedCss);
  console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);

  console.log('\nStep 4/6: Configuring project...');
  stepStart = Date.now();

  createComponentsJson(projectDir, options);

  const wranglerPath = join(projectDir, 'wrangler.jsonc');
  if (existsSync(wranglerPath)) {
    let wranglerConfig = readFileSync(wranglerPath, 'utf-8');
    wranglerConfig = wranglerConfig.replace(/"name":\s*"[^"]+"/, `"name": "${projectName}"`);
    writeFileSync(wranglerPath, wranglerConfig);
  }

  const packageJsonPath = join(projectDir, 'package.json');
  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    packageJson.name = projectName;
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, '\t') + '\n');
  }

  console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);

  console.log('\nStep 5/6: Copying notebook input...');
  stepStart = Date.now();
  const targetNotebookPath = join(projectDir, 'public', 'notebook.ipynb');
  cpSync(sourceNotebookPath, targetNotebookPath, { force: true });
  console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);

  console.log('\nStep 6/6: Installing dependencies...');
  stepStart = Date.now();
  const installResult = spawnSync('bun', ['install'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true,
  });

  if (installResult.status !== 0) {
    console.error('\nWarning: Failed to install dependencies. You can run "bun install" manually.');
  } else {
    console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);
  }

  const totalTime = Date.now() - totalStart;
  console.log(`
Project created successfully in ${formatTime(totalTime)}!

Next steps:
  cd ${projectName}
  bun dev          # Start Vite dev server
  bun run deploy   # Deploy to Cloudflare

<system-reminder>
IMPORTANT: Read \`${projectName}/CLAUDE.md\` for where the bundled notebook input and copied renderer code live.

The notebook you provided has been copied to \`${projectName}/public/notebook.ipynb\`.
</system-reminder>
`);
}

const args = process.argv.slice(2);
const parsed = parseArgs(args);

if (parsed.help || args.length === 0) {
  showHelp();
  process.exit(0);
}

if (!parsed.projectName) {
  console.error('Error: Project name required');
  showHelp();
  process.exit(1);
}

if (!parsed.notebookPath) {
  console.error('Error: --notebook <path> is required');
  showHelp();
  process.exit(1);
}

const validationErrors = validateOptions(parsed.options);
if (validationErrors.length > 0) {
  console.error('Validation errors:');
  validationErrors.forEach((err) => console.error(`  - ${err}`));
  process.exit(1);
}

createProject(parsed.projectName, parsed.notebookPath, parsed.options);
