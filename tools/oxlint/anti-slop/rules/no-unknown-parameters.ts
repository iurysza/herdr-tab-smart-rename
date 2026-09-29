import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  containsUnknownType,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function isTypePredicateSubject(owner: ParameterOwner, parameterName: string): boolean {
  const predicate = owner.returnType?.typeAnnotation;
  return (
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier" &&
    predicate.parameterName.name === parameterName
  );
}

function memberName(node: ESTree.CallExpression): string | null {
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return null;

  return callee.property.name;
}

function isSchemaParser(node: ESTree.CallExpression, owner: ParameterOwner, sourceCode: { getText(node: ESTree.Node): string; visitorKeys: Record<string, readonly string[] | undefined> }): boolean {
  if (!['parse', 'safeParse'].includes(memberName(node) ?? '')) return false;
  let program: ESTree.Node | ESTree.Program = owner;
  while (program.type !== 'Program' && program.parent) program = program.parent;
  if (program.type !== 'Program' || !program.body.some((statement) => statement.type === 'ImportDeclaration' && statement.source.value === 'zod' && statement.specifiers.some((specifier) => specifier.local.name === 'z'))) return false;
  const receiver = (node.callee as ESTree.MemberExpression).object;
  if (receiver.type === 'CallExpression' && memberName(receiver) === 'instanceof' &&
    receiver.callee.type === 'MemberExpression' && receiver.callee.object.type === 'Identifier' && receiver.callee.object.name === 'z') return true;
  if (receiver.type !== 'Identifier' || !receiver.name.endsWith('Schema')) return false;

  return program.body.some((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    return declaration?.type === 'VariableDeclaration' && declaration.declarations.some((entry) =>
      entry.id.type === 'Identifier' && entry.id.name === receiver.name && entry.init !== null &&
      /^(?:z\.object\(|z\.string\(|z\.enum\()/.test(sourceCode.getText(entry.init).replace(/\s+/g, '')));
  });
}

function bodyReferences(owner: ParameterOwner, name: string, visitorKeys: Record<string, readonly string[] | undefined>): ESTree.Node[] {
  if (!('body' in owner) || !owner.body || owner.body.type !== 'BlockStatement') return [];
  const references: ESTree.Node[] = [];
  const visit = (node: ESTree.Node): void => {
    if (node.type === 'Identifier' && node.name === name) references.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && 'type' in item) visit(item as ESTree.Node);
        }
      } else if (child && typeof child === 'object' && 'type' in child) {
        visit(child as ESTree.Node);
      }
    }
  };
  visit(owner.body);

  return references;
}

function normalizedUnknown(owner: ParameterOwner, name: string, context: { sourceCode: { getText(node: ESTree.Node): string; visitorKeys: Record<string, readonly string[] | undefined> } }): boolean {
  if (!('body' in owner) || !owner.body || owner.body.type !== 'BlockStatement') return false;
  const references = bodyReferences(owner, name, context.sourceCode.visitorKeys);
  if (!references.length) return false;
  const text = context.sourceCode.getText(owner.body);
  const normalized = text.replace(/\s+/g, '');
  const functionName = 'id' in owner && owner.id?.type === 'Identifier' ? owner.id.name : '';
  let program: ESTree.Node | ESTree.Program = owner;
  while (program.type !== 'Program' && program.parent) program = program.parent;
  const imported = (module: string): boolean => program.type === 'Program' && program.body.some((statement) => statement.type === 'ImportDeclaration' && statement.source.value === module);
  const coercionOwner =
    (functionName === 'isDefaultLabel' && normalized.includes('constvalue=String(label??"").trim();') && normalized.includes('return!value||/^\\d+$/.test(value)||value===String(number??"");')) ||
    (functionName === 'titleCase' && normalized.includes('returnString(input??"").replace(') && normalized.includes('.map((word)') && text.includes('.join(" ")')) ||
    (functionName === 'sanitizeText' && references.length === 1 && imported('secret-sniff') && imported('strip-ansi') && normalized.includes('lettext=stripAnsi(String(input??""));') && (normalized.match(/text=redact\(text,/g)?.length ?? 0) >= 3 && normalized.includes('returntext.replace(') && normalized.includes('.trim();')) ||
    (functionName === 'fingerprint' && imported('node:crypto') && normalized.includes('returncreateHash("sha256").update(JSON.stringify(value)).digest("hex");')) ||
    (functionName === 'boundedText' && imported('secret-sniff') && normalized.includes('returnsanitizeText(input,home).slice(0,max);'));
  const parsedError = references.some((reference) => {
    const call = reference.parent;
    if (call?.type !== 'CallExpression' || !call.arguments.some((argument) => argument.start === reference.start && argument.end === reference.end) || !isSchemaParser(call, owner, context.sourceCode)) return false;
    const receiver = call.callee.type === 'MemberExpression' ? call.callee.object : null;
    return receiver?.type === 'CallExpression' && memberName(receiver) === 'instanceof' &&
      receiver.arguments[0]?.type === 'Identifier' && receiver.arguments[0].name === 'Error';
  });

  return references.every((reference) => {
    let child: ESTree.Node = reference;
    let parent: ESTree.Node | null = child.parent;
    if (parent === null) return false;
    if (parent.type === 'LogicalExpression' && (parent.operator === '??' || parent.operator === '||') && parent.left === child && parent.right.type === 'Literal' && typeof parent.right.value === 'string') {
      child = parent;
      parent = child.parent;
    }
    if (parent?.type !== 'CallExpression' || !parent.arguments.some((argument) => argument.start === child.start && argument.end === child.end)) return false;
    if (isSchemaParser(parent, owner, context.sourceCode)) return true;
    if (parent.callee.type === 'Identifier') {
      if (parent.callee.name === 'String') return parsedError || coercionOwner;
      if (parent.callee.name === 'sanitizeText') return functionName === 'boundedText' || (functionName === 'validateTabLabel' && coercionOwner);
    }
    return parent.callee.type === 'MemberExpression' && memberName(parent) === 'stringify' &&
      parent.callee.object.type === 'Identifier' && parent.callee.object.name === 'JSON' &&
      functionName === 'fingerprint' && coercionOwner;
  });
}

/** Disallow unknown inputs unless each use is consumed by the checked boundary. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause` and type-predicate subjects; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        const name = functionParameterBindingName(parameter, context.sourceCode);
        if (name === "cause" || isTypePredicateSubject(node, name)) continue;
        if (normalizedUnknown(node, name, context)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
