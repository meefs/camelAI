#!/usr/bin/env node
/**
 * create-worker - Scaffold Cloudflare Worker projects with React Router v7 and shadcn/ui
 *
 * Usage:
 *   create-worker <project-name> [options]
 *
 * Options:
 *   --style <style>         UI style (vega, nova, maia, lyra, mira) [default: mira]
 *   --theme <color>         Theme color [default: neutral]
 *   --base-color <color>    Base gray color (neutral, zinc, gray, stone) [default: neutral]
 *   --icons <library>       Icon library [default: lucide]
 *   --font <font>           Font family [default: inter]
 *   --radius <size>         Border radius [default: default]
 *   --menu-color <type>     Menu color style [default: default]
 *   --menu-accent <type>    Menu accent style [default: subtle]
 *   --help                  Show this help message
 */

import { execFileSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

// Valid option values
const OPTIONS = {
  style: ['vega', 'nova', 'maia', 'lyra', 'mira'],
  baseColor: ['neutral', 'zinc', 'gray', 'stone'],
  theme: ['neutral', 'amber', 'blue', 'cyan', 'emerald', 'fuchsia', 'green', 'indigo', 'lime', 'orange', 'pink', 'purple', 'red', 'rose', 'sky', 'teal', 'violet', 'yellow', 'zinc', 'gray', 'stone'],
  iconLibrary: ['lucide', 'tabler', 'hugeicons', 'phosphor', 'remixicon'],
  font: ['inter', 'noto-sans', 'nunito-sans', 'figtree'],
  radius: ['default', 'none', 'small', 'medium', 'large'],
  menuColor: ['default', 'inverted'],
  menuAccent: ['subtle', 'bold'],
};

const DEFAULTS = {
  style: 'mira',
  baseColor: 'neutral',
  theme: 'neutral',
  iconLibrary: 'lucide',
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

  --icons <library>       Icon library [default: ${DEFAULTS.iconLibrary}]
                          Values: ${OPTIONS.iconLibrary.join(', ')}

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
  create-worker my-app --icons tabler --font figtree --radius large
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
    } else if (arg === '--icons' && args[i + 1]) {
      result.options.iconLibrary = args[++i];
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
    iconLibrary: options.iconLibrary,
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
    "iconLibrary": options.iconLibrary,
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

  // Generate radius mappings
  const radiusVars = `    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) + 4px);
    --radius-2xl: calc(var(--radius) + 8px);
    --radius-3xl: calc(var(--radius) + 12px);
    --radius-4xl: calc(var(--radius) + 16px);`;

  return `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "${fontConfig.package}";

@custom-variant dark (&:is(.dark *));

:root {
${lightVars}
}

.dark {
${darkVars}
}

@theme inline {
    --font-sans: ${fontConfig.fontFamily};
${themeColors}
${radiusVars}
}

@layer base {
  * {
    @apply border-border outline-ring/50;
    }
  body {
    @apply font-sans bg-background text-foreground;
    }
  html {
    @apply font-sans;
    }
}
`;
}

function copyTemplate(templateName, projectDir) {
  const templatePath = join(TEMPLATES_DIR, templateName);
  if (!existsSync(templatePath)) {
    throw new Error(`Template '${templateName}' not found at ${templatePath}`);
  }
  // Use juicefs sync for fast copying on JuiceFS filesystem
  // --perms preserves execute bits (needed for esbuild binary)
  // --links preserves symlinks
  // Trailing slashes ensure we copy contents into projectDir
  execFileSync('juicefs', ['sync', '--threads', '40', '--list-threads', '4', '--perms', '--links', `${templatePath}/`, `${projectDir}/`], { stdio: 'pipe' });
}

async function createProject(projectName, options) {
  const projectDir = join(process.cwd(), projectName);

  if (existsSync(projectDir)) {
    console.error(`Error: Directory '${projectName}' already exists`);
    process.exit(1);
  }

  console.log(`Creating Cloudflare Worker project: ${projectName}`);
  console.log(`Style: ${options.style}, Theme: ${options.theme}, Icons: ${options.iconLibrary}`);
  console.log('');

  // Step 1: Copy React Router + Cloudflare template
  console.log('Step 1/4: Copying React Router + Cloudflare template...');
  try {
    copyTemplate('react-router', projectDir);
  } catch (error) {
    console.error('Failed to copy template:', error.message);
    process.exit(1);
  }

  // Step 2: Fetch shadcn preset configuration from API
  console.log('\nStep 2/4: Fetching shadcn styling configuration...');
  const presetUrl = buildPresetUrl(options);
  let presetConfig;

  try {
    presetConfig = await fetchPresetConfig(presetUrl);
  } catch (error) {
    console.error('Failed to fetch shadcn configuration:', error.message);
    process.exit(1);
  }

  // Step 3: Generate and write CSS
  console.log('\nStep 3/4: Applying shadcn styling...');
  const targetCssPath = join(projectDir, 'app', 'app.css');
  const generatedCss = generateCssFromPreset(presetConfig, options);
  writeFileSync(targetCssPath, generatedCss);

  // Step 4: Configure project for shadcn
  console.log('\nStep 4/4: Configuring project...');

  // Create components.json (dynamic based on user options)
  createComponentsJson(projectDir, options);

  console.log(`
Project created successfully!

Next steps:
  cd ${projectName}
  yarn dev            # Start development server
  yarn deploy         # Deploy to Cloudflare

Add shadcn components:
  yarn dlx shadcn@latest add button card input
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
