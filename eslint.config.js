import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true } } },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
