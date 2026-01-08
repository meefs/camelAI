#!/usr/bin/env node
/**
 * create-worker - Scaffold Cloudflare Worker projects from templates
 *
 * Usage:
 *   create-worker <template> <project-name> [options]
 *
 * Templates:
 *   nextjs-fullstack  - Next.js app with API routes and optional auth
 *
 * Options:
 *   --auth            - Include authentication boilerplate
 *   --help            - Show this help message
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

const TEMPLATES = {
  'nextjs-fullstack': {
    name: 'Next.js Fullstack',
    description: 'Next.js app with API routes, Durable Objects, and OpenNext for Cloudflare',
    options: {
      auth: 'Include session-based authentication with Durable Objects',
    },
  },
};

function showHelp() {
  console.log(`
create-worker - Scaffold Cloudflare Worker projects from templates

Usage:
  create-worker <template> <project-name> [options]

Templates:`);

  for (const [key, template] of Object.entries(TEMPLATES)) {
    console.log(`  ${key.padEnd(20)} - ${template.description}`);
    if (template.options) {
      for (const [opt, desc] of Object.entries(template.options)) {
        console.log(`    --${opt.padEnd(16)} ${desc}`);
      }
    }
  }

  console.log(`
Examples:
  create-worker nextjs-fullstack my-app
  create-worker nextjs-fullstack my-app --auth
`);
}

function parseArgs(args) {
  const result = {
    template: null,
    projectName: null,
    options: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (arg.startsWith('--')) {
      const opt = arg.slice(2);
      result.options[opt] = true;
    } else if (!result.template) {
      result.template = arg;
    } else if (!result.projectName) {
      result.projectName = arg;
    }
  }

  return result;
}

function copyTemplateDir(srcDir, destDir, replacements) {
  if (!existsSync(srcDir)) return;

  mkdirSync(destDir, { recursive: true });

  for (const item of readdirSync(srcDir)) {
    const srcPath = join(srcDir, item);
    let destName = item;

    // Handle template file naming (e.g., _gitignore -> .gitignore)
    if (destName.startsWith('_')) {
      destName = '.' + destName.slice(1);
    }

    const destPath = join(destDir, destName);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyTemplateDir(srcPath, destPath, replacements);
    } else {
      let content = readFileSync(srcPath, 'utf-8');

      // Apply replacements
      for (const [key, value] of Object.entries(replacements)) {
        content = content.replaceAll(`{{${key}}}`, value);
      }

      writeFileSync(destPath, content);
    }
  }
}

function createProject(template, projectName, options) {
  const templateDir = join(TEMPLATES_DIR, template);
  const projectDir = join(process.cwd(), projectName);

  if (existsSync(projectDir)) {
    console.error(`Error: Directory '${projectName}' already exists`);
    process.exit(1);
  }

  if (!existsSync(templateDir)) {
    console.error(`Error: Template '${template}' not found`);
    process.exit(1);
  }

  console.log(`Creating ${TEMPLATES[template].name} project: ${projectName}`);

  // Base replacements
  const replacements = {
    PROJECT_NAME: projectName,
    AUTH_ENABLED: options.auth ? 'true' : 'false',
  };

  // Copy base template files
  const filesDir = join(templateDir, 'files');
  copyTemplateDir(filesDir, projectDir, replacements);

  // Copy auth files if --auth is specified
  if (options.auth) {
    const authDir = join(templateDir, 'files-auth');
    if (existsSync(authDir)) {
      copyTemplateDir(authDir, projectDir, replacements);
      console.log('  + Added authentication boilerplate');
    }
  }

  console.log(`
Project created successfully!

Next steps:
  cd ${projectName}
  npm install
  npm run dev       # Local development
  wrangler deploy   # Deploy to Cloudflare
`);
}

// Main
const args = process.argv.slice(2);
const parsed = parseArgs(args);

if (parsed.help || args.length === 0) {
  showHelp();
  process.exit(0);
}

if (!parsed.template) {
  console.error('Error: Template name required');
  showHelp();
  process.exit(1);
}

if (!TEMPLATES[parsed.template]) {
  console.error(`Error: Unknown template '${parsed.template}'`);
  console.log('\nAvailable templates:');
  for (const key of Object.keys(TEMPLATES)) {
    console.log(`  ${key}`);
  }
  process.exit(1);
}

if (!parsed.projectName) {
  console.error('Error: Project name required');
  showHelp();
  process.exit(1);
}

createProject(parsed.template, parsed.projectName, parsed.options);
