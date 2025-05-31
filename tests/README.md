# Humble Bundle Downloader Tests

## Test Structure

The test suite is organized as follows:

- `mock/` - Contains mock data for testing
- `types/` - Tests for type definitions
- `utils/` - Tests for utility functions
- `integration/` - Integration tests

## Running Tests

To run all tests:

```bash
deno task test
```

To run tests with coverage:

```bash
deno task test:coverage
```

## Writing Tests

When adding new tests:

1. Place unit tests alongside the code they test in the appropriate directory
2. Use mock data from `mock/mockData.ts` when possible
3. Follow the existing patterns for consistency
4. Ensure tests are isolated and don't depend on external resources

## Mocking Guidelines

- Use the `@std/testing/mock` module for mocking functions and classes
- Create mock data that closely resembles real data
- Use `FakeTime` from `@std/testing/time` for testing time-dependent code
