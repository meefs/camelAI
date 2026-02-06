import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import {
  STEP_PATHS,
  getNextStep,
  getPreviousStep,
  type OnboardingOption as OnboardingOptionConfig,
  type OnboardingStepId,
  type OnboardingTransitionDirection,
} from '@/lib/onboarding';
import type { OnboardingPreferences } from '@/types';
import { OnboardingOption } from './onboarding-option';
import { useDelayedAdvance } from './use-delayed-advance';

type SingleChoiceField =
  | 'ai_familiarity'
  | 'iteration_style'
  | 'stakes'
  | 'starter_project';

type SingleChoiceValue<TField extends SingleChoiceField> =
  NonNullable<OnboardingPreferences[TField]>;

type SingleChoiceStepId = Extract<OnboardingStepId, 'q1' | 'q2' | 'q3' | 'q5'>;

interface SingleChoiceContext {
  answers: OnboardingPreferences;
  currentStepIndex: number;
  totalSteps: number;
  transitionDirection: OnboardingTransitionDirection;
  sequence: OnboardingStepId[];
  teamMode: boolean;
  updateAnswers: (updates: Partial<OnboardingPreferences>) => void;
}

interface SingleChoiceStepProps<TField extends SingleChoiceField> {
  context: SingleChoiceContext;
  stepId: SingleChoiceStepId;
  field: TField;
  title: string;
  description?: string;
  options: OnboardingOptionConfig<SingleChoiceValue<TField>>[];
  renderIcon?: (value: SingleChoiceValue<TField>) => ReactNode;
}

export function SingleChoiceStep<TField extends SingleChoiceField>({
  context,
  stepId,
  field,
  title,
  description,
  options,
  renderIcon,
}: SingleChoiceStepProps<TField>) {
  const navigate = useNavigate();
  const querySuffix = context.teamMode ? '?team=1' : '';
  const previousStep = getPreviousStep(stepId, context.sequence);
  const nextStep = getNextStep(stepId, context.sequence);
  const { isAdvancing, scheduleAdvance } = useDelayedAdvance(() => {
    if (!nextStep) return;
    navigate(`${STEP_PATHS[nextStep]}${querySuffix}`);
  });
  const selectedValue = context.answers[field] as SingleChoiceValue<TField> | null;

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => {
        if (isAdvancing) return;
        if (!previousStep) return;
        navigate(`${STEP_PATHS[previousStep]}${querySuffix}`);
      }}
      onSkip={() => {
        if (isAdvancing) return;
        context.updateAnswers({ [field]: null } as Partial<OnboardingPreferences>);
        if (!nextStep) return;
        navigate(`${STEP_PATHS[nextStep]}${querySuffix}`);
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-muted-foreground">{description}</p>
          ) : null}
        </div>

        <div className="space-y-3">
          {options.map((option) => (
            <OnboardingOption
              key={option.value}
              selected={selectedValue === option.value}
              title={option.title}
              description={option.description}
              icon={renderIcon?.(option.value)}
              disabled={isAdvancing}
              onClick={() => {
                if (isAdvancing) return;
                context.updateAnswers({
                  [field]: option.value,
                } as Partial<OnboardingPreferences>);
                scheduleAdvance();
              }}
            />
          ))}
        </div>
      </div>
    </OnboardingLayout>
  );
}
