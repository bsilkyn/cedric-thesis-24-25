import type { Context } from '@live-sasylf/client';
import { createEffect, createSignal, For, Show, type Component } from 'solid-js';
import { Theorem } from '@/components/Theorem';
import { Fact } from '@/components/Fact';
import { Goal } from '@/components/Goal';
import { CaseAnalysis } from '@/components/CaseAnalysis';

const App: Component = () => {
	const [context, setContext] = createSignal<Context | undefined>(undefined);

	createEffect(() => {
		window.addEventListener('message', (msg) => {
			setContext(msg.data);
		});
	});

	return (
		<Show when={context()}>
			{c => (
				<div class="mx-2 my-4 flex flex-col gap-2 font-droid">
					<Show when={c().currentTheorem}>
						{t => <h1><Theorem theorem={t()} /></h1>}
					</Show>

					<div class="ml-4 flex flex-col gap-2">
						<div class="grid grid-cols-[auto_auto_1fr] gap-1">
							<For each={c().derivations}>
								{(derivation) => <Fact>{derivation}</Fact>}
							</For>
						</div>

						<Show when={c().derivations.length}>
							<hr />
						</Show>

						<Show when={c().goal}>
							{g => <p><Goal goal={g()} /></p>}
						</Show>

						<Show when={c().caseAnalysisContext}>
							{cac => <CaseAnalysis context={cac()} />}
						</Show>
					</div>
				</div>
			)
			}
		</Show >
	);
};

export default App;
