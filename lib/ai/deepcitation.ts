import { DeepCitation } from "deepcitation";

let instance: DeepCitation | null = null;

export function getDeepCitationClient(): DeepCitation | null {
  if (!process.env.DEEPCITATION_API_KEY) {
    return null;
  }

  if (!instance) {
    instance = new DeepCitation({
      apiKey: process.env.DEEPCITATION_API_KEY,
    });
  }

  return instance;
}
