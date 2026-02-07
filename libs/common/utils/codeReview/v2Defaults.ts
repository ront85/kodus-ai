// Default guidance for Code Review v2 categories and severity (string-only).
// These strings are newline-separated to render easily in textareas.

export const V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT = {
    bug: [
        '- Execution breaks: Code throws unhandled exceptions',
        "- Wrong results: Output doesn't match expected behavior",
        '- Resource leaks: Unclosed files, connections, memory accumulation',
        '- State corruption: Invalid object/data states',
        '- Logic errors: Control flow produces incorrect outcomes',
        '- Race conditions: Concurrent access causes inconsistent state or duplicates',
        "- Incorrect measurements: Metrics/timings that don't reflect actual operations",
        '- Invariant violations: Broken constraints (size limits, uniqueness, etc.)',
        '- Async timing bugs: Variables captured incorrectly in async closures',
        '- Conditional validation errors: Logic that checks for presence/absence of values using truthiness tests that fail with falsy values (0, None, False, ""). Examples: Python `if dict.get("key")` should be `if "key" in dict`; Ruby `if @cache[key]` fails when cached value is `false` or `nil`, should use `@cache.key?(key)` or `.include?`',
        '- Mutable default arguments: In Ruby, Python, and similar languages, mutable default parameter values (e.g., Ruby `def method(hash: {})`, `def method(arr: [])`, Python `def method(list=[])`) are evaluated ONCE at method definition, not on each call. All calls sharing the default receive the SAME object, so mutations (append, insert, key assignment) accumulate across calls',
        '- Floating-point equality: Using `==` to compare floating-point results (e.g., `total == expected`, `balance == 0.0`, `price1 == price2`) will fail due to IEEE 754 precision errors. Use epsilon-based comparison (`(a - b).abs < threshold`) or decimal/rational types for financial calculations',
        '- Closure capturing mutable references: Lambdas, Procs, or closures that capture a variable by reference will see mutations made to that variable AFTER closure creation. In Ruby, `lambda { process(config) }` inside a loop captures `config` by reference - if `config` is mutated after the lambda is stored, the lambda will use the mutated value when called later',
        '- Dead computation: Code that computes/transforms values but never uses the result, instead using the original untransformed value - indicates copy-paste error or incomplete refactoring',
        '- Unbounded growth: Collections (lists, dicts, sets) that grow indefinitely within loops without size limits, potentially causing memory exhaustion',
        '- Duplicate operations: Same operation executed multiple times with identical inputs in sequence, wasting resources and potentially causing incorrect counts/metrics',
    ].join('\n'),
    performance: [
        '- Algorithm complexity: O(n²) when O(n) is possible',
        '- Redundant operations: Duplicate calculations, unnecessary loops, or early returns that force multiple operations when a single operation would suffice (e.g., fail-fast in batch processing that requires multiple requests to get complete feedback)',
        '- Memory waste: Large allocations or leaks over time',
        '- Blocking operations: Synchronous I/O in critical paths',
        '- Database inefficiency: N+1, missing indexes, full scans',
        '- Cache misses: Not leveraging available caching mechanisms',
        '- Batch processing inefficiency: Validation or processing loops that return on first error instead of collecting all errors, forcing clients to make multiple requests to discover all issues',
    ].join('\n'),
    security: [
        '- Injection vulnerabilities: SQL/NoSQL/command/LDAP injection',
        '- AuthZ/AuthN flaws: Missing checks, privilege escalation',
        '- Data exposure: Sensitive data in logs, responses, or errors',
        '- Crypto issues: Weak algorithms, hardcoded keys, improper validation',
        '- Input validation gaps: Missing sanitization or bounds checks',
        '- Session management: Predictable tokens or missing expiration',
        '- Timing attacks: Direct string/value comparison of secrets, tokens, passwords, or authentication credentials that leaks information through execution time - must use constant-time comparison functions',
        '- Insecure fallback values: Using empty strings, default values, or weak fallbacks for critical security parameters (encryption keys, secrets, tokens) when environment variables are missing - system should fail-fast instead',
        '- Input validation bypass: User-controlled parameters (offsets, limits, indices, IDs) accepted without validation or with inadequate bounds checking, especially negative values in array slicing or pagination that could bypass access controls',
        '- SSRF (Server-Side Request Forgery): Using user-controlled URLs in network operations (open, fetch, HTTP requests) without allowlist validation, enabling access to internal resources or arbitrary external sites',
        "- Case-sensitivity bypass: Inconsistent normalization in comparisons of case-insensitive data (emails, usernames, domains) where one side is normalized (toLowerCase/toUpperCase) but the other isn't, allowing bypass through case variations",
    ].join('\n'),
};

export const V2_DEFAULT_SEVERITY_FLAGS_TEXT = {
    critical: [
        'Application crash/downtime',
        'Data loss/corruption',
        'Security breach (unauthorized access/data exfiltration)',
        'Critical operation failure (auth/payment/authorization)',
        'Direct financial loss operations',
        'Memory leaks that inevitably crash production',
    ].join('\n'),
    high: [
        'Important functionality broken',
        'Memory leaks that cause eventual crash',
        'Performance degradation affecting UX under normal load',
        'Security issues with indirect exploitation paths',
        'Financial calculation errors affecting revenue',
    ].join('\n'),
    medium: [
        'Partially broken functionality',
        'Performance issues in specific scenarios',
        'Security weaknesses requiring specific conditions',
        'Incorrect but recoverable data',
        'Non-critical business logic errors with workarounds',
    ].join('\n'),
    low: [
        'Minor performance overhead',
        'Low-risk security improvements',
        'Incorrect metrics/logs',
        'Rarely affecting few users',
        'Edge-case issues',
    ].join('\n'),
};

export function getV2DefaultsText() {
    return {
        categories: { ...V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT },
        severity: { ...V2_DEFAULT_SEVERITY_FLAGS_TEXT },
    };
}
