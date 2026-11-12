export type Scenario = "default" | "empty" | "disconnected" | "blocked" | "unknown-cost";

export interface ScreenProps {
  scenario: Scenario;
}
