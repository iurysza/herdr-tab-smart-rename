import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  createTypeAliasEnvironment,
  resolvedTypeMatches,
  type TypeAliasEnvironment,
} from "../shared/type-alias-resolution.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function isInjectedActionResult(node: FunctionWithReturnType, sourceCode: { getText(node: ESTree.Node): string }): boolean {
  if (node.type !== 'TSFunctionType' || node.parent.type !== 'TSTypeParameterInstantiation' || node.parent.parent.type !== 'TSTypeReference') return false;
  const record = node.parent.parent;
  if (record.typeName.type !== 'Identifier' || record.typeName.name !== 'Record') return false;
  const annotation = record.parent;
  if (annotation.type !== 'TSTypeAnnotation' || annotation.parent.type !== 'TSPropertySignature') return false;
  const property = annotation.parent;
  if (property.key.type !== 'Identifier' || property.key.name !== 'actions') return false;
  const owner = property.parent.parent;
  if (owner?.type !== 'TSInterfaceDeclaration' || owner.id.name !== 'DispatchOptions') return false;

  return node.params.length === 1 && sourceCode.getText(node.params[0]).replace(/\s+/g, '') === 'options:{dryRun:boolean}' &&
    record.typeArguments?.params[0]?.type === 'TSStringKeyword';
}

function isDelegatedActionResult(node: FunctionWithReturnType, sourceCode: { getText(node: ESTree.Node): string }): boolean {
  if (node.type !== 'FunctionDeclaration' || node.id?.name !== 'dispatch' || node.body?.type !== 'BlockStatement') return false;
  const returns = node.body.body.filter((item) => item.type === 'ReturnStatement');
  if (returns.length !== 1 || returns[0].argument?.type !== 'CallExpression') return false;
  const call = returns[0].argument;
  if (call.callee.type !== 'Identifier' || call.callee.name !== 'action' || call.arguments.length !== 1 ||
    sourceCode.getText(call.arguments[0]).replace(/\s+/g, '') !== '{dryRun}') return false;
  const body = sourceCode.getText(node.body);

  return body.includes('actions[command]') && body.includes('if (!action)') && body.includes('throw new Error(');
}

/** Ban function contracts that return unknown except the checked opaque action seam. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    let environment: TypeAliasEnvironment | null = null;

    const resolvesToUnknown = (type: ESTree.TSType): boolean =>
      environment !== null &&
      resolvedTypeMatches(type, environment, (resolved, matches) => {
        if (resolved.type === "TSUnknownKeyword") return true;
        if (resolved.type === "TSParenthesizedType") {
          return matches(resolved.typeAnnotation);
        }
        if (resolved.type === "TSUnionType") return resolved.types.some(matches);
        if (
          resolved.type !== "TSTypeReference" ||
          resolved.typeName.type !== "Identifier" ||
          (resolved.typeName.name !== "Promise" &&
            resolved.typeName.name !== "PromiseLike")
        ) {
          return false;
        }
        const value = resolved.typeArguments?.params[0];
        return value !== undefined && matches(value);
      });

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation)) return;
      if (isInjectedActionResult(node, context.sourceCode) || isDelegatedActionResult(node, context.sourceCode)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        environment = createTypeAliasEnvironment(
          node,
          context.sourceCode.visitorKeys,
        );
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
