import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  eslintConfigPrettier,
  {
    ignores: [
      "repos_eval/**",
      "deps/**",
      ".next/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      "drizzle/**",
      "node_modules/**",
    ],
  },
];

export default eslintConfig;
