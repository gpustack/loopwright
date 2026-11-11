import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '.test-build/**', '**/.claude/**', 'site/**', '.sbin/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
);
