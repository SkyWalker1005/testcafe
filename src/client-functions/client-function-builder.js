import { isNil as isNullOrUndefined, assign } from 'lodash';
import testRunTracker from '../api/test-run-tracker';
import functionBuilderSymbol from './builder-symbol';
import { createReplicator, FunctionTransform } from './replicator';
import { ExecuteClientFunctionCommand } from '../test-run/commands/observation';
import compileClientFunction from '../compiler/compile-client-function';
import { APIError, ClientFunctionAPIError } from '../errors/runtime';
import { assertType, is } from '../errors/runtime/type-assertions';
import { RUNTIME_ERRORS } from '../errors/types';
import { getCallsiteForMethod } from '../errors/get-callsite';
import ReExecutablePromise from '../utils/re-executable-promise';
import testRunMarker from '../test-run/marker-symbol';
import selectorApiExecutionMode from './selector-api-execution-mode';
import CHECK_ELEMENT_DELAY from '../client/driver/command-executors/client-functions/selector-executor/check-element-delay';
import TEMPLATES from '../errors/test-run/templates';
import dedent from 'dedent';

const DEFAULT_EXECUTION_CALLSITE_NAME = '__$$clientFunction$$';

export default class ClientFunctionBuilder {
    constructor (fn, options, callsiteNames = {}) {
        this.callsiteNames = {
            instantiation: callsiteNames.instantiation,
            execution:     callsiteNames.execution || DEFAULT_EXECUTION_CALLSITE_NAME,
        };

        if (isNullOrUndefined(options))
            options = {};

        this._validateOptions(options);

        this.fn             = fn;
        this.options        = options;
        this.compiledFnCode = this._getCompiledFnCode();

        if (!this.compiledFnCode)
            throw this._createInvalidFnTypeError();

        this.replicator = createReplicator(this._getReplicatorTransforms());
    }

    _renderError (error) {
        // The rendered template is shown in the Watch panel of browser dev tools or IDE.
        // Viewport size is unlimited there.
        const viewportWidth   = Number.MIN_SAFE_INTEGER;
        const renderedMessage = TEMPLATES[error.code](error, viewportWidth);

        return dedent(renderedMessage);
    }

    _decorateFunction (clientFn) {
        clientFn[functionBuilderSymbol] = this;

        clientFn.with = options => {
            return this._getClientFnWithOverriddenOptions(options);
        };
    }

    _getClientFnWithOverriddenOptions (options) {
        if (typeof options === 'object')
            options = assign({}, this.options, options);

        const builder = new this.constructor(this.fn, options, {
            instantiation: 'with',
            execution:     this.callsiteNames.execution,
        });

        return builder.getFunction();
    }

    getBoundTestRun () {
        // NOTE: `boundTestRun` can be either TestController or TestRun instance.
        if (this.options.boundTestRun)
            return this.options.boundTestRun.testRun || this.options.boundTestRun;

        return null;
    }

    _getTestRun () {
        return this.getBoundTestRun() || testRunTracker.resolveContextTestRun();
    }

    _getObservedCallsites () {
        return this._getTestRun()?.observedCallsites || null;
    }

    getFunction () {
        const builder = this;

        const clientFn = function __$$clientFunction$$ () {
            const testRun  = builder._getTestRun();
            const callsite = getCallsiteForMethod(builder.callsiteNames.execution);
            const args     = [];

            // OPTIMIZATION: don't leak `arguments` object.
            for (let i = 0; i < arguments.length; i++)
                args.push(arguments[i]);

            if (selectorApiExecutionMode.isSync)
                return builder._executeCommandSync(args, testRun, callsite);

            return builder._executeCommand(args, testRun, callsite);
        };

        this._decorateFunction(clientFn);

        return clientFn;
    }

    getCommand (args) {
        const encodedArgs         = this.replicator.encode(args);
        const encodedDependencies = this.replicator.encode(this.getFunctionDependencies());

        return this._createTestRunCommand(encodedArgs, encodedDependencies);
    }


    // Overridable methods
    getFunctionDependencies () {
        return this.options.dependencies || {};
    }

    _createTestRunCommand (encodedArgs, encodedDependencies) {
        return new ExecuteClientFunctionCommand({
            instantiationCallsiteName: this.callsiteNames.instantiation,
            fnCode:                    this.compiledFnCode,
            args:                      encodedArgs,
            dependencies:              encodedDependencies,
        }, this._getTestRun());
    }

    _getCompiledFnCode () {
        if (typeof this.fn === 'function')
            return compileClientFunction(this.fn.toString(), this.options.dependencies, this.callsiteNames.instantiation, this.callsiteNames.instantiation);

        return null;
    }

    _createInvalidFnTypeError () {
        return new ClientFunctionAPIError(this.callsiteNames.instantiation, this.callsiteNames.instantiation, RUNTIME_ERRORS.clientFunctionCodeIsNotAFunction, typeof this.fn);
    }

    _executeCommand (args, testRun, callsite) {
        // NOTE: should be kept outside of lazy promise to preserve
        // correct callsite in case of replicator error.
        const command = this.getCommand(args);

        return ReExecutablePromise.fromFn(async () => {
            if (!testRun) {
                const err = new ClientFunctionAPIError(this.callsiteNames.execution, this.callsiteNames.instantiation, RUNTIME_ERRORS.clientFunctionCannotResolveTestRun);

                // NOTE: force callsite here, because more likely it will
                // be impossible to resolve it by method name from a lazy promise.
                err.callsite = callsite;

                throw err;
            }

            const result = await testRun.executeCommand(command, callsite);

            return this._processResult(result, args);
        });
    }

    _executeCommandSync (args, testRun, callsite) {
        // NOTE: should be kept outside of lazy promise to preserve
        // correct callsite in case of replicator error.
        const command = this.getCommand(args);

        if (!testRun) {
            const err = new ClientFunctionAPIError(this.callsiteNames.execution, this.callsiteNames.instantiation, RUNTIME_ERRORS.clientFunctionCannotResolveTestRun);

            // NOTE: force callsite here, because more likely it will
            // be impossible to resolve it by method name from a lazy promise.
            err.callsite = callsite;

            throw err;
        }

        // NOTE: reset the command timeout to minimal check interval to
        // ensure the find element loop will execute only one time.
        if (typeof command.timeout !== 'number')
            command.timeout = CHECK_ELEMENT_DELAY;

        try {
            const result = testRun.executeCommandSync(command, callsite);

            return this._processResult(result, args);
        }
        catch (err) {
            throw this._renderError(err);
        }
    }

    _processResult (result) {
        return this.replicator.decode(result);
    }

    _validateOptions (options) {
        assertType(is.nonNullObject, this.callsiteNames.instantiation, 'The "options" argument', options);

        if (!isNullOrUndefined(options.boundTestRun)) {
            // NOTE: `boundTestRun` can be either TestController or TestRun instance.
            const boundTestRun = options.boundTestRun.testRun || options.boundTestRun;

            if (!boundTestRun[testRunMarker])
                throw new APIError(this.callsiteNames.instantiation, RUNTIME_ERRORS.invalidClientFunctionTestRunBinding);
        }

        if (!isNullOrUndefined(options.dependencies))
            assertType(is.nonNullObject, this.callsiteNames.instantiation, 'The "dependencies" option', options.dependencies);
    }

    _getReplicatorTransforms () {
        return [
            new FunctionTransform(this.callsiteNames),
        ];
    }
}
