/*
 * This script recursively copies a directory or file, performing substitutions on files
 * with a `.tmpl` extension. It uses a JSON file for substitution data.
 *
 * Template Syntax: {{ expression }}
 *
 * The expression inside the curly braces is resolved based on the provided JSON data.
 *
 * --- Expression Features ---
 *
 * 1.  **Variable Substitution:**
 *     - `{{ key }}`: Looks up `key` in the JSON file. Supports nested keys like `{{ user.name }}`.
 *
 * 2.  **Fallbacks:**
 *     - `{{ key1 | key2 }}`: Tries to resolve `key1`. If it's undefined, it tries `key2`.
 *       You can chain multiple fallbacks.
 *
 * 3.  **Modifiers:**
 *     - `{{ key:modifier1:modifier2 }}`: Applies a series of transformations to the resolved value.
 *     - Available Modifiers:
 *       - `json`: Converts the value to a JSON string.
 *         - `{{ data:json }}` -> JSON.stringify(data, null, 2)
 *         - `{{ data:json:4 }}` -> JSON.stringify(data, null, 4)
 *       - `lower`: Converts the string to lowercase.
 *       - `upper`: Converts the string to uppercase.
 *       - `_`: Replaces all hyphens (`-`) with underscores (`_`).
 *       - `-`: Replaces all underscores (`_`) with hyphens (`-`).
 *
 * 4.  **Default Values:**
 *     - `{{ key = default value }}`: If `key` cannot be resolved, `default value` is used as a
 *       literal string. The value is everything after the first `=`. It is not quoted.
 *
 * 5.  **Substitution in Default Values:**
 *     - `{{ key = Hello, @user.name@ }}`: If `key` is unresolved, the default value is used,
 *       and any `@variable@` inside it is substituted from the JSON data. This secondary
 *       substitution does not support the full expression engine (no modifiers, fallbacks, etc.).
 *
 * --- Combination Example ---
 *
 * `{{ package.name | app.name:lower:- = my-default-app }}`
 *
 * 1.  Tries to find `package.name` in the JSON data.
 * 2.  If not found, tries to find `app.name`.
 * 3.  If `app.name` is found, it's converted to lowercase, and its underscores are replaced with hyphens.
 * 4.  If neither is found, the default value `my-default-app` is used.
 *
 * --- Usage ---
 *
 * node copy-and-subst.mjs <source_path> <json_data_file> <target_path>
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Safely retrieves a nested value from an object using a dot-separated path.
 * @param {object} obj The object to query.
 * @param {string} path The dot-separated path to the desired value.
 * @returns {any | undefined} The value if found, otherwise undefined.
 */
function get(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' && key in acc) ? acc[key] : undefined, obj);
}

/**
 * Applies a series of modifiers to a value.
 * @param {any} value The input value.
 * @param {string[]} modifiers An array of modifier strings (e.g., ['json', '4']).
 * @returns {string} The transformed value as a string.
 */
function applyModifiers(value, modifiers) {
  let result = value;
  for (let i = 0; i < modifiers.length; i++) {
    const mod = modifiers[i];
    if (mod === 'json') {
      const indent = (i + 1 < modifiers.length && !isNaN(parseInt(modifiers[i+1], 10))) ? parseInt(modifiers[++i], 10) : 2;
      result = JSON.stringify(result, null, indent);
    } else if (typeof result === 'string') {
      // Apply string-specific modifiers
      switch (mod) {
        case 'lower':
          result = result.toLowerCase();
          break;
        case 'upper':
          result = result.toUpperCase();
          break;
        case '_':
          result = result.replace(/-/g, '_');
          break;
        case '-':
          result = result.replace(/_/g, '-');
          break;
      }
    }
  }
  return result;
}

/**
 * Resolves a template expression against a substitutions object.
 * Handles fallbacks, default values, and modifiers.
 * @param {string} expr The expression string (the content inside {{...}}).
 * @param {object} substitutions The object containing substitution values.
 * @param {string} sourcePath The path of the file being processed, for error reporting.
 * @returns {string} The resolved and processed string value.
 */
function resolveExpression(expr, substitutions, sourcePath) {
  const [fallbacksStr, ...defaultParts] = expr.split('=').map(s => s.trim());
  const defaultValue = defaultParts.length > 0 ? defaultParts.join('=').trim() : undefined;

  let resolvedValue;
  const fallbacks = fallbacksStr.split('|').map(s => s.trim());

  for (const fallback of fallbacks) {
    const [path, ...modifiers] = fallback.split(':').map(s => s.trim());
    const value = get(substitutions, path);

    if (value !== undefined) {
      resolvedValue = applyModifiers(value, modifiers);
      break;
    }
  }

  if (resolvedValue === undefined) {
    if (defaultValue !== undefined) {
      // If a default value is provided, perform secondary substitution on it.
      resolvedValue = defaultValue.replace(/@([^@]+)@/g, (innerMatch, innerPath) => {
        const innerValue = get(substitutions, innerPath.trim());
        if (typeof innerValue === 'string' || typeof innerValue === 'number') {
          return innerValue;
        }
        throw new Error(`Variable '@${innerPath.trim()}@' inside default for '${expr}' in '${sourcePath}' must resolve to a string or number.`);
      });
    } else {
      // If no value could be found and there's no default, throw an error.
      throw new Error(`Variable '${fallbacks.join(' | ')}' could not be resolved in file '${sourcePath}'.`);
    }
  }
  return String(resolvedValue);
}

/**
 * Recursively copies a directory or file, performing substitutions on .tmpl files.
 * @param {string} source The absolute path to the source file or directory.
 * @param {string} target The absolute path to the target file or directory.
 * @param {object} substitutions The object containing substitution values.
 */
export async function copyAndSubstitute(source, target, substitutions) {
  const sourceStats = await fs.stat(source);

  if (sourceStats.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const file of await fs.readdir(source)) {
      await copyAndSubstitute(path.join(source, file), path.join(target, file), substitutions);
    }
  } else if (sourceStats.isFile()) {
    const finalTargetPath = target.endsWith('.tmpl') ? target.slice(0, -5) : target;
    await fs.mkdir(path.dirname(finalTargetPath), { recursive: true });

    if (source.endsWith('.tmpl')) {
      let content = await fs.readFile(source, 'utf-8');

      const regex = /{{\s*([^}]+?)\s*}}/g;
      const replacements = [];

      // First, find all expressions and resolve their values.
      for (const match of content.matchAll(regex)) {
        const fullMatch = match[0];
        const expr = match[1];
        const replacement = resolveExpression(expr, substitutions, source);
        replacements.push({ find: fullMatch, replace: replacement });
      }

      // Then, apply all replacements. Using split/join is safer than chained .replace()
      // with values that might contain special regex characters.
      for(const rep of replacements) {
        content = content.split(rep.find).join(rep.replace);
      }

      await fs.writeFile(finalTargetPath, content, 'utf-8');
    } else {
      // If not a template file, just copy it directly.
      await fs.copyFile(source, finalTargetPath);
    }
  }
}

/**
 * Main execution function. Parses command-line arguments and starts the process.
 */
async function main() {
  const [source, jsonFile, target] = process.argv.slice(2);
  if (!source || !jsonFile || !target) {
    const argv1 = process.argv[1] ? path.relative(
      process.cwd(), process.argv[1]
    ) : 'copy-replace.mjs';
    console.error(`Usage: ${process.argv0} ${argv1} <source> <json-file> <target>`);
    process.exit(1);
  }
  try {
    const substitutions = JSON.parse(await fs.readFile(jsonFile, 'utf-8'));
    await copyAndSubstitute(path.resolve(source), path.resolve(target), substitutions);
    console.log(`Copied ${source} to ${target} with substitution defined by ${jsonFile}.`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run main only if the script is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
