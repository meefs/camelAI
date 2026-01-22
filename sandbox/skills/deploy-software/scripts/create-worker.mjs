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

import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from 'fs';
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: options.silent ? 'pipe' : 'inherit',
      shell: true,
      cwd: options.cwd,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    if (options.silent) {
      proc.stdout?.on('data', (data) => { stdout += data; });
      proc.stderr?.on('data', (data) => { stderr += data; });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}\n${stderr}`));
      }
    });

    proc.on('error', reject);
  });
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

function createUtilsFile(projectDir) {
  const utilsDir = join(projectDir, 'app', 'lib');
  mkdirSync(utilsDir, { recursive: true });

  const utilsContent = `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`;

  writeFileSync(join(utilsDir, 'utils.ts'), utilsContent);
}

function updatePackageJson(projectDir, projectName, options) {
  const pkgPath = join(projectDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  // Update name
  pkg.name = projectName;

  // Remove resolutions (only needed for Docker build with local Verdaccio)
  delete pkg.resolutions;

  // Get the font package based on selected font
  const fontConfig = FONT_CONFIG[options.font] || FONT_CONFIG['inter'];
  const fontPackage = fontConfig.package;

  // Add shadcn dependencies
  pkg.dependencies = {
    ...pkg.dependencies,
    [fontPackage]: "^5.2.5",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.4.0",
    "tw-animate-css": "^1.4.0",
    "shadcn": "^3.7.0",
  };

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function updateViteConfig(projectDir) {
  const vitePath = join(projectDir, 'vite.config.ts');
  let content = readFileSync(vitePath, 'utf-8');

  // Add vite-tsconfig-paths if not present (for ~ alias support)
  if (!content.includes('tsconfigPaths')) {
    // Already included in the RR7 template
  }

  writeFileSync(vitePath, content);
}

function stripJsonComments(str) {
  // Remove block comments /* ... */
  str = str.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments // ...
  str = str.replace(/\/\/.*$/gm, '');
  return str;
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
  cpSync(templatePath, projectDir, { recursive: true });
}

function updateTsConfig(projectDir) {
  // shadcn CLI reads the main tsconfig.json for path aliases
  // We need to add paths to both the main tsconfig.json and tsconfig.cloudflare.json

  // Update main tsconfig.json for shadcn CLI
  const tsconfigPath = join(projectDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    let content = readFileSync(tsconfigPath, 'utf-8');
    const config = JSON.parse(stripJsonComments(content));

    // Add paths for ~ alias so shadcn CLI can resolve them
    config.compilerOptions = config.compilerOptions || {};
    config.compilerOptions.baseUrl = ".";
    config.compilerOptions.paths = {
      "~/*": ["./app/*"]
    };

    writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n');
  }

  // Also update tsconfig.cloudflare.json for TypeScript/Vite
  const cloudflareConfigPath = join(projectDir, 'tsconfig.cloudflare.json');
  if (existsSync(cloudflareConfigPath)) {
    let cfContent = readFileSync(cloudflareConfigPath, 'utf-8');
    const cfConfig = JSON.parse(stripJsonComments(cfContent));

    // Add paths for ~ alias
    cfConfig.compilerOptions = cfConfig.compilerOptions || {};
    cfConfig.compilerOptions.baseUrl = ".";
    cfConfig.compilerOptions.paths = {
      "~/*": ["./app/*"]
    };

    writeFileSync(cloudflareConfigPath, JSON.stringify(cfConfig, null, 2) + '\n');
  }
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

  // Create components.json
  createComponentsJson(projectDir, options);

  // Create utils.ts
  createUtilsFile(projectDir);

  // Update package.json
  updatePackageJson(projectDir, projectName, options);

  // Update tsconfig for ~ alias
  updateTsConfig(projectDir);

  // Update .yarnrc.yml to remove Verdaccio registry (only needed for Docker build)
  const yarnrcPath = join(projectDir, '.yarnrc.yml');
  if (existsSync(yarnrcPath)) {
    const yarnrcContent = `nodeLinker: pnp

# Store cache locally for portability
enableGlobalCache: false
`;
    writeFileSync(yarnrcPath, yarnrcContent);
  }

  // Install dependencies with Yarn PnP
  console.log('\nInstalling dependencies with Yarn...');
  try {
    await runCommand('yarn', ['install'], { cwd: projectDir });
  } catch (error) {
    console.warn('Note: Run `yarn install` in your project directory to install dependencies');
  }

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
