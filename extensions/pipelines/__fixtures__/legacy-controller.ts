import { PipelineController } from "../controller.ts";
import { FEATURE_PIPELINE_ID, type PipelineRunRequest } from "../domain.ts";

/** Tests for dormant historical controller internals only. The production
 * controller/tool always rejects retired launches; no caller parameter can
 * enable this fixture adapter. New public-contract tests use PipelineController. */
export class LegacyPipelineTestController extends PipelineController {
  protected override assertLaunchSupported() {}

  override start(request: PipelineRunRequest) {
    return super.start({
      ...request,
      pipeline: request.pipeline ?? FEATURE_PIPELINE_ID,
    });
  }
}
