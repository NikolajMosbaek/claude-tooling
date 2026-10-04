import { describe, expect, test } from 'claude-code/testing'

import { findXcodebuilds, summarizeLog } from '../hooks/builds'

describe('findXcodebuilds sees the build and where its output goes', () => {
  test('a redirect with 2>&1, the repo convention', () => {
    expect(
      findXcodebuilds(
        "xcodebuild -project MyApp/MyApp.xcodeproj -scheme 'MyApp Test' -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' test > /private/tmp/s/test.log 2>&1",
      ),
    ).toEqual([{ action: 'test', scheme: 'MyApp Test', logPath: '/private/tmp/s/test.log' }])
  })
  test('&> and an env prefix', () => {
    expect(findXcodebuilds('DEVELOPER_DIR=/Applications/Xcode-26.6.app xcodebuild build -scheme App &> b.log')).toEqual([
      { action: 'build', scheme: 'App', logPath: 'b.log' },
    ])
  })
  test('a relative log after cd', () => {
    expect(findXcodebuilds('cd .worktrees/x && xcodebuild test-without-building -scheme S > out/t.log 2>&1')).toEqual([
      { action: 'test-without-building', scheme: 'S', logPath: '.worktrees/x/out/t.log' },
    ])
  })
  test('tee in the pipeline', () => {
    expect(findXcodebuilds('set -o pipefail; xcodebuild -scheme S build 2>&1 | tee -a /tmp/b.log | grep error')).toEqual([
      { action: 'build', scheme: 'S', logPath: '/tmp/b.log' },
    ])
  })
  test('no log when output goes nowhere', () => {
    expect(findXcodebuilds('xcodebuild -scheme S build')).toEqual([{ action: 'build', scheme: 'S', logPath: undefined }])
    expect(findXcodebuilds('xcodebuild -scheme S build > /dev/null')).toEqual([
      { action: 'build', scheme: 'S', logPath: undefined },
    ])
  })
  test('information commands are not builds', () => {
    expect(findXcodebuilds('xcodebuild -version')).toEqual([])
    expect(findXcodebuilds('xcodebuild -list -project P.xcodeproj')).toEqual([])
    expect(findXcodebuilds('grep -n "xcodebuild" CLAUDE.md')).toEqual([])
    expect(findXcodebuilds('echo xcodebuild test > notes.txt')).toEqual([])
  })
  test('wrappers in front of xcodebuild', () => {
    expect(findXcodebuilds('xcrun xcodebuild -scheme S test > t.log')).toEqual([{ action: 'test', scheme: 'S', logPath: 't.log' }])
  })
})

describe('summarizeLog', () => {
  test('a failed test run', () => {
    const grep = [
      '/r/Foo.swift:12:5: error: cannot find x in scope',
      '/r/Foo.swift:12:5: error: cannot find x in scope',
      '✘ Test "parses" recorded an issue at FooTests.swift:9:3: Expectation failed',
      '✘ Test run with 812 tests in 120 suites failed after 41.2 seconds with 1 issue.',
      '** TEST FAILED **',
    ].join('\n')
    const tail = ['', 'Failing tests:', '\tFooTests.parses()', '', '** TEST FAILED **', ''].join('\n')
    expect(summarizeLog(grep, tail)).toEqual({
      banners: ['TEST FAILED'],
      errors: ['/r/Foo.swift:12:5: error: cannot find x in scope'],
      issues: ['✘ Test "parses" recorded an issue at FooTests.swift:9:3: Expectation failed'],
      testSummary: '✘ Test run with 812 tests in 120 suites failed after 41.2 seconds with 1 issue.',
      failingTests: ['FooTests.parses()'],
      lastLine: '** TEST FAILED **',
    })
  })
  test('test-without-building prints its own banner', () => {
    expect(summarizeLog('** TEST EXECUTE SUCCEEDED **', '').banners).toEqual(['TEST EXECUTE SUCCEEDED'])
  })
  test('a banner with timing after it', () => {
    expect(summarizeLog('** BUILD SUCCEEDED ** [41.2 sec]', '').banners).toEqual(['BUILD SUCCEEDED'])
  })
  test('XCTest totals', () => {
    expect(summarizeLog('Executed 40 tests, with 2 failures (0 unexpected) in 1.2 (1.3) seconds', '').testSummary).toBe(
      'Executed 40 tests, with 2 failures (0 unexpected) in 1.2 (1.3) seconds',
    )
  })
})
