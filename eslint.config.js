// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'coverage', 'src/generated'] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Permite descartar campos com rest: const { omitido, ...resto } = obj
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },

  // Nos testes, matchers como expect.any() e expect.arrayContaining() são tipados como `any`
  // pelo próprio Vitest; sem isto, toda asserção parcial vira erro de lint.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Editar linhas de planilhas simuladas (rows[0]![5] = 35) fica mais legível assim.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Arquivos JS (como este) não estão no tsconfig: desliga as regras que exigem tipos.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },

  // Sempre por último: desliga regras de estilo que conflitam com o Prettier.
  prettier,
);
