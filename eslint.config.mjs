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
		ignores: [
			"build/**",
			"dist/**",
			"node_modules/**",
			".react-router/**",
			"**/.wrangler/**",
			"**/*.d.ts",
		],
	},
];
