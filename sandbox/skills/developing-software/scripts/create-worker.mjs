#!/usr/bin/env node
/**
 * create-worker - Scaffold Cloudflare Worker projects with React Router v7 and shadcn/ui
 *
 * Uses JuiceFS clone for instant project creation via copy-on-write.
 * Golden template has yarn install done, so cloned projects are ready to use.
 *
 * Usage:
 *   create-worker <project-name> [options]
 *
 * Options:
 *   --style <style>         UI style (vega, nova, maia, lyra, mira) [default: mira]
 *   --theme <color>         Theme color [default: neutral]
 *   --base-color <color>    Base gray color (neutral, zinc, gray, stone) [default: neutral]
 *   --font <font>           Font family [default: inter]
 *   --radius <size>         Border radius [default: default]
 *   --menu-color <type>     Menu color style [default: default]
 *   --menu-accent <type>    Menu accent style [default: subtle]
 *   --help                  Show this help message
 */

import { execFileSync, spawnSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

// Golden template location on JuiceFS (has yarn install done)
const GOLDEN_TEMPLATES_DIR = join(process.env.HOME || '/home/claude', '.chiridion', 'templates');

// Valid option values
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

// Map font names to their @fontsource-variable package names and CSS font family names
const FONT_CONFIG = {
  'inter': { package: '@fontsource-variable/inter', fontFamily: "'Inter Variable', sans-serif" },
  'noto-sans': { package: '@fontsource-variable/noto-sans', fontFamily: "'Noto Sans Variable', sans-serif" },
  'nunito-sans': { package: '@fontsource-variable/nunito-sans', fontFamily: "'Nunito Sans Variable', sans-serif" },
  'figtree': { package: '@fontsource-variable/figtree', fontFamily: "'Figtree Variable', sans-serif" },
};

function showHelp() {
  console.log(`
create-worker - Scaffold Cloudflare Worker projects with React Router v7 and shadcn/ui

Usage:
  create-worker <project-name> [options]

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
  create-worker my-app
  create-worker my-app --style nova --theme blue
  create-worker my-app --theme zinc --base-color zinc
  create-worker my-app --font figtree --radius large
`);
}

function parseArgs(args) {
  const result = {
    projectName: null,
    options: { ...DEFAULTS },
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      return { help: true };
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

  // When theme is a gray-scale (zinc/gray/stone), baseColor must match
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
    "$schema": "https://ui.shadcn.com/schema.json",
    "style": `radix-${options.style}`,
    "rsc": false,
    "tsx": true,
    "tailwind": {
      "config": "",
      "css": "app/app.css",
      "baseColor": options.baseColor,
      "cssVariables": true,
      "prefix": ""
    },
    "iconLibrary": "lucide",
    "aliases": {
      "components": "~/components",
      "utils": "~/lib/utils",
      "ui": "~/components/ui",
      "lib": "~/lib",
      "hooks": "~/hooks"
    },
    "menuColor": options.menuColor,
    "menuAccent": options.menuAccent,
    "registries": {}
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
  const fontConfig = FONT_CONFIG[options.font] || FONT_CONFIG['inter'];
  const { light, dark } = preset.cssVars;

  // Generate CSS variable declarations
  const lightVars = Object.entries(light)
    .map(([key, value]) => `    --${key}: ${value};`)
    .join('\n');

  const darkVars = Object.entries(dark)
    .map(([key, value]) => `    --${key}: ${value};`)
    .join('\n');

  // Generate @theme inline color mappings
  const themeColors = Object.keys(light)
    .filter(key => key !== 'radius')
    .map(key => `    --color-${key}: var(--${key});`)
    .join('\n');

  // Read template and replace placeholders
  const templatePath = join(TEMPLATES_DIR, 'chiridion-starter', 'app', 'app.css.template');
  const template = readFileSync(templatePath, 'utf-8');

  return template
    .replace('{{FONT_IMPORT}}', fontConfig.package)
    .replace('{{FONT_FAMILY}}', fontConfig.fontFamily)
    .replace('{{LIGHT_VARS}}', lightVars)
    .replace('{{DARK_VARS}}', darkVars)
    .replace('{{THEME_COLORS}}', themeColors);
}

/**
 * Wait for golden template to be ready.
 * Returns path to golden template, or null if not available.
 */
function waitForGoldenTemplate(templateName) {
  const goldenTemplate = join(GOLDEN_TEMPLATES_DIR, templateName);
  const lockFile = join(GOLDEN_TEMPLATES_DIR, `.${templateName}.lock`);
  const pnpFile = join(goldenTemplate, '.pnp.cjs');

  // Wait for lock file to be removed (max 2 minutes)
  let waited = false;
  for (let i = 0; i < 120 && existsSync(lockFile); i++) {
    if (!waited) {
      console.log(`         Waiting for golden template...`);
      waited = true;
    }
    spawnSync('sleep', ['1']);
  }

  return existsSync(pnpFile) ? goldenTemplate : null;
}

/**
 * Clone template using JuiceFS copy-on-write (instant)
 */
function copyTemplate(templateName, projectDir) {
  const start = Date.now();
  const goldenTemplate = waitForGoldenTemplate(templateName);
  const waitTime = Date.now() - start;

  if (!goldenTemplate) {
    throw new Error('Golden template not ready. Please try again in a moment.');
  }

  if (waitTime > 100) {
    console.log(`         (waited ${waitTime}ms for golden template)`);
  }

  console.log(`         Cloning template (JuiceFS copy-on-write)...`);

  const cloneStart = Date.now();
  const result = spawnSync('juicefs', ['clone', goldenTemplate, projectDir], {
    stdio: 'pipe',
  });
  const cloneTime = Date.now() - cloneStart;

  console.log(`         Clone took ${cloneTime}ms`);

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    throw new Error(`JuiceFS clone failed: ${stderr}`);
  }
}

function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function createProject(projectName, options) {
  const totalStart = Date.now();
  const projectDir = join(process.cwd(), projectName);

  if (existsSync(projectDir)) {
    console.error(`Error: Directory '${projectName}' already exists`);
    process.exit(1);
  }

  console.log(`Creating Cloudflare Worker project: ${projectName}`);
  console.log(`Style: ${options.style}, Theme: ${options.theme}, Font: ${options.font}`);
  console.log('');

  // Step 1: Clone React Router + Cloudflare template (instant via JuiceFS copy-on-write)
  console.log('Step 1/4: Cloning React Router + Cloudflare template...');
  let stepStart = Date.now();
  try {
    copyTemplate('chiridion-starter', projectDir);
    console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);
  } catch (error) {
    console.error('Failed to clone template:', error.message);
    process.exit(1);
  }

  // Step 2: Fetch shadcn preset configuration from API
  console.log('\nStep 2/4: Fetching shadcn styling configuration...');
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

  // Step 3: Generate and write CSS
  console.log('\nStep 3/4: Applying shadcn styling...');
  stepStart = Date.now();
  const targetCssPath = join(projectDir, 'app', 'app.css');
  const generatedCss = generateCssFromPreset(presetConfig, options);
  writeFileSync(targetCssPath, generatedCss);
  console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);

  // Step 4: Configure project for shadcn
  console.log('\nStep 4/4: Configuring project...');
  stepStart = Date.now();

  // Create components.json (dynamic based on user options)
  createComponentsJson(projectDir, options);

  // Update wrangler.jsonc with project name
  const wranglerPath = join(projectDir, 'wrangler.jsonc');
  if (existsSync(wranglerPath)) {
    let wranglerConfig = readFileSync(wranglerPath, 'utf-8');
    // Replace the name field (JSONC so can't use JSON.parse)
    wranglerConfig = wranglerConfig.replace(/"name":\s*"rr7-template"/, `"name": "${projectName}"`);
    writeFileSync(wranglerPath, wranglerConfig);
  }
  console.log(`         Done in ${formatTime(Date.now() - stepStart)}`);

  // Step 5: Pre-warm build daemon (background)
  console.log('\nStep 5/5: Pre-warming build daemon...');
  try {
    const { spawn } = await import('child_process');
    const warmup = spawn('yarn', ['node', '/app/vite-build.mjs', '--warmup'], {
      cwd: projectDir,
      stdio: 'inherit',
      detached: true,
    });
    warmup.unref();
    console.log(`         Started in background (first build will be faster)`);
  } catch (err) {
    console.log(`         Skipped: ${err.message}`);
  }

  const totalTime = Date.now() - totalStart;
  console.log(`
Project created successfully in ${formatTime(totalTime)}!

Next steps:
  cd ${projectName}
  yarn dev         # Start development server
  yarn deploy      # Deploy to Cloudflare

Add shadcn components (globally installed - do NOT use npx):
  shadcn add button card input

<system-reminder>
IMPORTANT: Read \`${projectName}/CLAUDE.md\` for a quick reference on the template structure, key files, and how to enable features like Durable Objects and AI chat.

The template has pre-configured AI chat code that's commented out - CLAUDE.md explains what to uncomment.

For comprehensive examples, see the \`developing-software\` skill documentation.
</system-reminder>
`);
}

// Main
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

const validationErrors = validateOptions(parsed.options);
if (validationErrors.length > 0) {
  console.error('Validation errors:');
  validationErrors.forEach((err) => console.error(`  - ${err}`));
  process.exit(1);
}

createProject(parsed.projectName, parsed.options);
