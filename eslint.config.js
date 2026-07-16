import js from "@eslint/js";
import globals from "globals";

export default [
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es2022,
			},
		},
		rules: {
			"no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"no-undef": "off", // TypeScript handles this
		},
	},
	{
		// Only first-party source is linted. Local/dev state, build output,
		// vendored assets, and generated bundles previously made `eslint .`
		// crawl ~30k files and take minutes.
		ignores: [
			"**/node_modules/**",
			"**/build/**",
			"**/dist/**",
			"**/.react-router/**",
			"**/.wrangler/**",
			"**/*.d.ts",
			"**/*.min.js",
			// Legacy local host checkout dir (in-repo sandbox-host was removed).
			".sandbox-host/**",
			".claude/**",
			"**/public/**",
			"**/coverage/**",
			"**/test-results/**",
			"**/playwright-report*/**",
			"sandbox/create-worker/renderer-dist/**",
		],
	},
];
