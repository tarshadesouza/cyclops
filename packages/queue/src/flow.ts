import { FlowProducer } from "bullmq";
import { getRedis } from "./redis.js";

let flowProducerInstance: FlowProducer | undefined;

export function getFlowProducer(): FlowProducer {
  if (!flowProducerInstance) {
    flowProducerInstance = new FlowProducer({ connection: getRedis() });
  }
  return flowProducerInstance;
}
