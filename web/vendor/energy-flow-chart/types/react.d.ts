import type { ForwardRefExoticComponent, RefAttributes, CSSProperties } from 'react';
import type { ChartOptions, EnergyFlowChart, Metric } from './index';

export interface EnergyFlowChartViewProps extends ChartOptions {
  className?: string;
  style?: CSSProperties;
  onReady?: (chart: EnergyFlowChart) => void;
}
export declare const EnergyFlowChartView: ForwardRefExoticComponent<EnergyFlowChartViewProps & RefAttributes<EnergyFlowChart>>;

export interface EnergyCardsViewProps { chart: EnergyFlowChart | null; metrics: Metric[]; minWidth?: number; className?: string; style?: CSSProperties }
export declare function EnergyCardsView(props: EnergyCardsViewProps): JSX.Element;

export interface EnergyDashboardProps extends EnergyFlowChartViewProps { metrics?: Metric[]; cardsMinWidth?: number; gap?: number }
export declare const EnergyDashboard: ForwardRefExoticComponent<EnergyDashboardProps & RefAttributes<EnergyFlowChart | null>>;

export interface EnergyFlowBoardProps extends Omit<import('./index').MountOptions, 'cards'> {
  view?: 'timeline' | 'tod';
  rangeMode?: 'day' | 'week';
  showCards?: boolean;
  className?: string;
  cardsClassName?: string;
  chartClassName?: string;
  style?: CSSProperties;
  gap?: number;
  onReady?: (handle: import('./index').MountHandle) => void;
}
export declare const EnergyFlowBoard: ForwardRefExoticComponent<EnergyFlowBoardProps & RefAttributes<import('./index').MountHandle | null>>;
