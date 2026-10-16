export interface XCResultFailure {
  test: string;
  message: string;
}
export declare function failureReport(tree: unknown): XCResultFailure[];
export declare function annotation(failure: XCResultFailure): string;
