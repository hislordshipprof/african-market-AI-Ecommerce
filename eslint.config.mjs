import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const unsafeRawBans = [
  {
    selector: "MemberExpression[property.name='$executeRawUnsafe']",
    message: "Use tagged $executeRaw instead of $executeRawUnsafe.",
  },
  {
    selector: "MemberExpression[property.name='$queryRawUnsafe']",
    message: "Use tagged $queryRaw instead of $queryRawUnsafe.",
  },
];

const taggedRawBans = [
  {
    selector: "MemberExpression[property.name='$executeRaw']",
    message: "Raw SQL is only allowed in src/lib/db.ts.",
  },
  {
    selector: "MemberExpression[property.name='$queryRaw']",
    message: "Raw SQL is only allowed in src/lib/db.ts.",
  },
];

const eslintConfig = [
  { ignores: [".claude/**", "playwright-report/**"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/db.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...unsafeRawBans, ...taggedRawBans],
    },
  },
  {
    files: ["src/lib/db.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...unsafeRawBans],
    },
  },
];

export default eslintConfig;
