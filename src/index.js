/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import {createHash} from 'crypto';
import * as p from 'path';
import {writeFileSync} from 'fs';
import {sync as mkdirpSync} from 'mkdirp';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = [
    'FormattedMessage',
    'FormattedHTMLMessage',
];

const FUNCTION_NAMES = [
    'defineMessage',
    'defineMessages',
];

const IMPORTED_NAMES   = new Set([...COMPONENT_NAMES, ...FUNCTION_NAMES]);
const DESCRIPTOR_PROPS = new Set(['id', 'description', 'defaultMessage']);

export default function ({Plugin, types: t}) {
    function getReactIntlOptions(options) {
        return options.extra['react-intl'] || {};
    }

    function getModuleSourceName(options) {
        return getReactIntlOptions(options).moduleSourceName || 'react-intl';
    }

    function getMessageDescriptorKey(path) {
        if (path.isIdentifier() || path.isJSXIdentifier()) {
            return path.node.name;
        }

        let evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }
    }

    function getMessageDescriptorValue(path) {
        if (path.isJSXExpressionContainer()) {
            path = path.get('expression');
        }

        let evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }

        if (path.isTemplateLiteral() && path.get('expressions').length === 0) {
            let str = path.get('quasis')
                .map((quasi) => quasi.node.value.cooked)
                .reduce((str, value) => str + value);

            return str;
        }

        throw path.errorWithNode(
            '[React Intl] Messages must be statically evaluate-able for extraction.'
        );
    }

    function createMessageDescriptor(propPaths) {
        return propPaths.reduce((hash, [keyPath, valuePath]) => {
            let key = getMessageDescriptorKey(keyPath);

            if (DESCRIPTOR_PROPS.has(key)) {
                let value = getMessageDescriptorValue(valuePath).trim();

                if (key === 'defaultMessage') {
                    try {
                        hash[key] = printICUMessage(value);
                    } catch (e) {
                        throw valuePath.errorWithNode(
                            `[React Intl] Message failed to parse: ${e} ` +
                            'See: http://formatjs.io/guides/message-syntax/'
                        );
                    }
                } else {
                    hash[key] = value;
                }
            }

            return hash;
        }, {});
    }

    function createIdPropNode(id) {
        return t.property('init', t.literal('id'), t.literal(id));
    }

    function generateMessageId({defaultMessage, description}, node, file) {
        if (!defaultMessage) {
            throw file.errorWithNode(node,
                '[React Intl] Message must have a `defaultMessage` or `id`.'
            );
        }

        let shasum = createHash('sha1');
        shasum.update(defaultMessage);

        if (description) {
            shasum.update(description);
        }

        return shasum.digest('hex');
    }

    function storeMessage({id, description, defaultMessage}, node, file) {
        const {enforceDescriptions} = getReactIntlOptions(file.opts);
        const {messages}            = file.get('react-intl');

        if (!defaultMessage) {
            let {loc} = node;
            file.log.warn(
                `[React Intl] Line ${loc.start.line}: ` +
                'Message is missing a `defaultMessage` and will not be extracted.'
            );

            return;
        }

        if (enforceDescriptions && !description) {
            throw file.errorWithNode(node,
                '[React Intl] Message must have a `description`.'
            );
        }

        if (!id) {
            throw file.errorWithNode(node,
                '[React Intl] Message is missing an `id`.'
            );
        }

        if (messages.has(id)) {
            let existing = messages.get(id);

            if (description !== existing.description ||
                defaultMessage !== existing.defaultMessage) {

                throw file.errorWithNode(node,
                    `[React Intl] Duplicate message id: "${id}", ` +
                    'but the `description` and/or `defaultMessage` are different.'
                );
            }
        }

        messages.set(id, {id, description, defaultMessage});
    }

    function referencesImport(path, mod, importedNames) {
        if (!(path.isIdentifier() || path.isJSXIdentifier())) {
            return false;
        }

        return importedNames.some((name) => path.referencesImport(mod, name));
    }

    return new Plugin('react-intl', {
        visitor: {
            Program: {
                enter(node, parent, scope, file) {
                    const moduleSourceName = getModuleSourceName(file.opts);
                    const {imports} = file.metadata.modules;

                    let mightHaveReactIntlMessages = imports.some((mod) => {
                        if (mod.source === moduleSourceName) {
                            return mod.imported.some((name) => {
                                return IMPORTED_NAMES.has(name);
                            });
                        }
                    });

                    if (mightHaveReactIntlMessages) {
                        file.set('react-intl', {
                            messages: new Map(),
                        });
                    } else {
                        this.skip();
                    }
                },

                exit(node, parent, scope, file) {
                    const {messages}  = file.get('react-intl');
                    const {messagesDir} = getReactIntlOptions(file.opts);
                    const {basename, filename} = file.opts;

                    let descriptors = [...messages.values()];
                    file.metadata['react-intl'] = {messages: descriptors};

                    if (messagesDir) {
                        let messagesFilename = p.join(
                            messagesDir,
                            p.dirname(p.relative(process.cwd(), filename)),
                            basename + '.json'
                        );

                        let messagesFile = JSON.stringify(descriptors, null, 2);

                        mkdirpSync(p.dirname(messagesFilename));
                        writeFileSync(messagesFilename, messagesFile);
                    }
                },
            },

            JSXOpeningElement(node, parent, scope, file) {
                const {
                    generateMessageIds,
                    removeExtractedData,
                } = getReactIntlOptions(file.opts);

                const moduleSourceName = getModuleSourceName(file.opts);

                let name = this.get('name');

                if (referencesImport(name, moduleSourceName, COMPONENT_NAMES)) {
                    let attributes = this.get('attributes')
                        .filter((attr) => attr.isJSXAttribute());

                    let descriptor = createMessageDescriptor(
                        attributes.map((attr) => [
                            attr.get('name'),
                            attr.get('value'),
                        ])
                    );

                    // In order for a default message to be extracted when
                    // declaring a JSX element, it must be done with standard
                    // `key=value` attributes. But it's completely valid to
                    // write `<FormattedMessage {...descriptor} />`, because it
                    // will be skipped here and extracted elsewhere.
                    if (descriptor.defaultMessage) {
                        if (generateMessageIds && !descriptor.id) {
                            let id = generateMessageId(descriptor, node, file);

                            let idAttribute = t.JSXAttribute(
                                t.literal('id'),
                                t.literal(id)
                            );

                            this.pushContainer('attributes', idAttribute);
                            descriptor = {...descriptor, id};
                        }

                        storeMessage(descriptor, node, file);

                        if (removeExtractedData) {
                            attributes
                                .filter((attr) => {
                                    let keyPath = attr.get('name');
                                    let key = getMessageDescriptorKey(keyPath);
                                    return key !== 'id' && DESCRIPTOR_PROPS.has(key);
                                })
                                .forEach((attr) => attr.dangerouslyRemove());
                        }
                    }
                }
            },

            CallExpression(node, parent, scope, file) {
                const {
                    generateMessageIds,
                    removeExtractedData,
                } = getReactIntlOptions(file.opts);

                const moduleSourceName = getModuleSourceName(file.opts);

                function processMessageObject(messageObj) {
                    if (!(messageObj && messageObj.isObjectExpression())) {
                        throw file.errorWithNode(node,
                            `[React Intl] \`${callee.node.name}()\` must be ` +
                            `called with message descriptor defined via an ` +
                            `object expression.`
                        );
                    }

                    let properties = messageObj.get('properties');

                    let descriptor = createMessageDescriptor(
                        properties.map((prop) => [
                            prop.get('key'),
                            prop.get('value'),
                        ])
                    );

                    if (generateMessageIds && !descriptor.id) {
                        let id     = generateMessageId(descriptor, node, file);
                        let idProp = createIdPropNode(id);

                        messageObj.unshiftContainer('properties', idProp);
                        descriptor = {...descriptor, id};
                    }

                    storeMessage(descriptor, node, file);

                    if (removeExtractedData) {
                        let idObjectExpression = t.objectExpression([
                            createIdPropNode(descriptor.id),
                        ]);

                        messageObj.replaceWith(idObjectExpression);
                    }
                }

                let callee = this.get('callee');

                if (referencesImport(callee, moduleSourceName, FUNCTION_NAMES)) {
                    let firstArg = this.get('arguments')[0];

                    if (callee.node.name === 'defineMessages') {
                        firstArg.get('properties')
                            .map((prop) => prop.get('value'))
                            .forEach(processMessageObject);
                    } else {
                        processMessageObject(firstArg);
                    }
                }
            },
        },
    });
}
