const require_client = require('../utils/client.cjs');
const require_tools = require('../utils/tools.cjs');
const require_base = require('./base.cjs');
const require_responses = require('../converters/responses.cjs');
let _langchain_core_language_models_base = require("@langchain/core/language_models/base");

//#region src/chat_models/responses.ts
/**
* OpenAI Responses API implementation.
*
* Patched to support ChatGPT Codex subscription tokens by:
* 1. Stripping unsupported params (text, temperature, service_tier, etc.)
* 2. Extracting developer message content into `instructions` field
* 3. Forcing `stream: true` and `store: false` (Codex requirements)
* 4. Collecting streamed response into a complete response when caller wants non-streaming
*
* @internal
*/
var ChatOpenAIResponses = class extends require_base.BaseChatOpenAI {
	constructor(modelOrFields, fieldsArg) {
		super(require_base.getChatOpenAIModelParams(modelOrFields, fieldsArg));
	}
	_isCodexSubscription() {
		const baseURL = this.clientConfig?.baseURL || '';
		return baseURL.includes('chatgpt.com/backend-api/codex');
	}
	_transformCodexRequest(request) {
		// Extract developer/system message content for the `instructions` field
		let instructions = '';
		const filteredInput = [];
		if (Array.isArray(request.input)) {
			for (const item of request.input) {
				if (item.role === 'developer' || item.role === 'system') {
					// Extract text content for instructions
					if (typeof item.content === 'string') {
						instructions += (instructions ? '\n' : '') + item.content;
					} else if (Array.isArray(item.content)) {
						for (const part of item.content) {
							if (part.type === 'input_text' || part.type === 'text') {
								instructions += (instructions ? '\n' : '') + (part.text || part.input_text || '');
							}
						}
					}
				} else {
					filteredInput.push(item);
				}
			}
		}
		const transformed = {
			model: request.model,
			input: filteredInput.length > 0 ? filteredInput : request.input,
			instructions: instructions || 'You are a helpful code review assistant.',
			stream: true,
			store: false
		};
		// Keep tools if present
		if (request.tools) transformed.tools = request.tools;
		if (request.tool_choice) transformed.tool_choice = request.tool_choice;
		return transformed;
	}
	async _collectCodexStream(stream) {
		// Collect a streaming response into a complete response object
		let fullText = '';
		let responseId = '';
		let model = '';
		let usage = null;
		const output = [];
		for await (const event of stream) {
			if (event.type === 'response.created' || event.type === 'response.in_progress') {
				if (event.response?.id) responseId = event.response.id;
				if (event.response?.model) model = event.response.model;
			}
			if (event.type === 'response.output_text.delta') {
				fullText += event.delta || '';
			}
			if (event.type === 'response.completed' || event.type === 'response.done') {
				if (event.response) {
					responseId = event.response.id || responseId;
					model = event.response.model || model;
					usage = event.response.usage || usage;
					if (event.response.output) {
						output.push(...event.response.output);
					}
				}
			}
		}
		// Build a response object that matches what non-streaming would return
		return {
			id: responseId,
			object: 'response',
			model: model,
			output: output.length > 0 ? output : [{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: fullText }]
			}],
			output_text: fullText,
			usage: usage
		};
	}
	invocationParams(options) {
		let strict;
		if (options?.strict !== void 0) strict = options.strict;
		if (strict === void 0 && this.supportsStrictToolCalling !== void 0) strict = this.supportsStrictToolCalling;
		const isCodex = this._isCodexSubscription();
		const params = {
			model: this.model,
			temperature: isCodex ? void 0 : this.temperature,
			top_p: isCodex ? void 0 : this.topP,
			user: isCodex ? void 0 : this.user,
			service_tier: isCodex ? void 0 : this.service_tier,
			stream: this.streaming,
			previous_response_id: options?.previous_response_id,
			truncation: isCodex ? void 0 : options?.truncation,
			include: options?.include,
			tools: options?.tools?.length ? this._reduceChatOpenAITools(options.tools, {
				stream: this.streaming,
				strict
			}) : void 0,
			tool_choice: require_tools.isBuiltInToolChoice(options?.tool_choice) ? options?.tool_choice : (() => {
				const formatted = require_tools.formatToOpenAIToolChoice(options?.tool_choice);
				if (typeof formatted === "object" && "type" in formatted) {
					if (formatted.type === "function") return {
						type: "function",
						name: formatted.function.name
					};
					else if (formatted.type === "allowed_tools") return {
						type: "allowed_tools",
						mode: formatted.allowed_tools.mode,
						tools: formatted.allowed_tools.tools
					};
					else if (formatted.type === "custom") return {
						type: "custom",
						name: formatted.custom.name
					};
				}
			})(),
			text: (() => {
				if (isCodex) return void 0;
				if (options?.text) return options.text;
				const format = this._getResponseFormat(options?.response_format);
				if (format?.type === "json_schema") {
					if (format.json_schema.schema != null) return {
						format: {
							type: "json_schema",
							schema: format.json_schema.schema,
							description: format.json_schema.description,
							name: format.json_schema.name,
							strict: format.json_schema.strict
						},
						verbosity: options?.verbosity
					};
					return;
				}
				return {
					format,
					verbosity: options?.verbosity
				};
			})(),
			parallel_tool_calls: isCodex ? void 0 : options?.parallel_tool_calls,
			max_output_tokens: isCodex ? void 0 : (this.maxTokens === -1 ? void 0 : this.maxTokens),
			prompt_cache_key: isCodex ? void 0 : (options?.promptCacheKey ?? this.promptCacheKey),
			prompt_cache_retention: isCodex ? void 0 : (options?.promptCacheRetention ?? this.promptCacheRetention),
			...this.zdrEnabled ? { store: false } : {},
			...this.modelKwargs
		};
		const reasoning = this._getReasoningParams(options);
		if (reasoning !== void 0 && !isCodex) params.reasoning = reasoning;
		if (isCodex) {
			delete params.store;
			Object.keys(params).forEach(key => {
				if (params[key] === void 0 || params[key] === null) delete params[key];
			});
		}
		return params;
	}
	async _generate(messages, options, runManager) {
		options.signal?.throwIfAborted();
		const invocationParams = this.invocationParams(options);
		if (invocationParams.stream) {
			const stream = this._streamResponseChunks(messages, options, runManager);
			let finalChunk;
			for await (const chunk of stream) {
				chunk.message.response_metadata = {
					...chunk.generationInfo,
					...chunk.message.response_metadata
				};
				finalChunk = finalChunk?.concat(chunk) ?? chunk;
			}
			return {
				generations: finalChunk ? [finalChunk] : [],
				llmOutput: { estimatedTokenUsage: (finalChunk?.message)?.usage_metadata }
			};
		} else {
			const data = await this.completionWithRetry({
				input: require_responses.convertMessagesToResponsesInput({
					messages,
					zdrEnabled: this.zdrEnabled ?? false,
					model: this.model
				}),
				...invocationParams,
				stream: false
			}, {
				signal: options?.signal,
				...options?.options
			});
			return {
				generations: [{
					text: data.output_text,
					message: require_responses.convertResponsesMessageToAIMessage(data)
				}],
				llmOutput: {
					id: data.id,
					estimatedTokenUsage: data.usage ? {
						promptTokens: data.usage.input_tokens,
						completionTokens: data.usage.output_tokens,
						totalTokens: data.usage.total_tokens
					} : void 0
				}
			};
		}
	}
	async *_streamResponseChunks(messages, options, runManager) {
		const streamIterable = await this.completionWithRetry({
			...this.invocationParams(options),
			input: require_responses.convertMessagesToResponsesInput({
				messages,
				zdrEnabled: this.zdrEnabled ?? false,
				model: this.model
			}),
			stream: true
		}, options);
		for await (const data of streamIterable) {
			if (options.signal?.aborted) return;
			const chunk = require_responses.convertResponsesDeltaToChatGenerationChunk(data);
			if (chunk == null) continue;
			yield chunk;
			await runManager?.handleLLMNewToken(chunk.text || "", {
				prompt: options.promptIndex ?? 0,
				completion: 0
			}, void 0, void 0, void 0, { chunk });
		}
	}
	async completionWithRetry(request, requestOptions) {
		return this.caller.call(async () => {
			const clientOptions = this._getClientOptions(requestOptions);
			try {
				if (this._isCodexSubscription()) {
					const wantedStream = request.stream;
					const codexRequest = this._transformCodexRequest(request);
					if (!this._codexLogged) {
						console.log('[CODEX_PATCH] Transformed request:', JSON.stringify({
							model: codexRequest.model,
							instructions: codexRequest.instructions?.substring(0, 80) + '...',
							inputCount: codexRequest.input?.length,
							stream: codexRequest.stream,
							store: codexRequest.store,
							originalStream: wantedStream
						}));
						this._codexLogged = true;
					}
					if (!wantedStream) {
						// Caller wants non-streaming but Codex requires streaming
						// Stream the response and collect it into a complete object
						const stream = await this.client.responses.create(codexRequest, clientOptions);
						return await this._collectCodexStream(stream);
					} else {
						// Caller wants streaming — pass through
						return await this.client.responses.create(codexRequest, clientOptions);
					}
				}
				if (request.text?.format?.type === "json_schema" && !request.stream) return await this.client.responses.parse(request, clientOptions);
				return await this.client.responses.create(request, clientOptions);
			} catch (e) {
				if (this._isCodexSubscription()) {
					console.error('[CODEX_PATCH] FAILED | error:', e?.message, '| status:', e?.status);
				}
				throw require_client.wrapOpenAIClientError(e);
			}
		});
	}
	/** @internal */
	_reduceChatOpenAITools(tools, fields) {
		const reducedTools = [];
		for (const tool of tools) if (require_tools.isBuiltInTool(tool)) {
			if (tool.type === "image_generation" && fields?.stream) tool.partial_images = 1;
			reducedTools.push(tool);
		} else if (require_tools.isCustomTool(tool)) {
			const customToolData = tool.metadata.customTool;
			reducedTools.push({
				type: "custom",
				name: customToolData.name,
				description: customToolData.description,
				format: customToolData.format
			});
		} else if ((0, _langchain_core_language_models_base.isOpenAITool)(tool)) reducedTools.push({
			type: "function",
			name: tool.function.name,
			parameters: tool.function.parameters,
			description: tool.function.description,
			strict: fields?.strict ?? null
		});
		else if (require_tools.isOpenAICustomTool(tool)) reducedTools.push(require_tools.convertCompletionsCustomTool(tool));
		return reducedTools;
	}
};

//#endregion
exports.ChatOpenAIResponses = ChatOpenAIResponses;
//# sourceMappingURL=responses.cjs.map
