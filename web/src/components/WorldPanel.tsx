import type { PlayState } from "../lib/api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";

export function WorldPanel({ state }: { state: PlayState }) {
  const present = new Set(state.scene.present);
  return (
    <Accordion type="multiple" defaultValue={["scene", "cast", "memory"]} className="w-full">
      <AccordionItem value="scene">
        <AccordionTrigger>场景</AccordionTrigger>
        <AccordionContent>
          <dl className="space-y-3 font-ui text-sm">
            <div>
              <dt className="text-secondary">地点</dt>
              <dd>{state.scene.location || "—"}</dd>
            </div>
            <div>
              <dt className="text-secondary">时间</dt>
              <dd>{state.scene.time || "—"}</dd>
            </div>
            <div>
              <dt className="text-secondary">备注</dt>
              <dd className="whitespace-pre-wrap">{state.scene.notes || "—"}</dd>
            </div>
          </dl>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="cast">
        <AccordionTrigger>演员表</AccordionTrigger>
        <AccordionContent>
          <ul className="space-y-3">
            {state.world.cast.map((member) => (
              <li key={member.id}>
                <p className="font-ui text-sm font-medium">
                  {member.name}{" "}
                  <span className="text-secondary">{present.has(member.id) ? "· 在场" : "· 不在场"}</span>
                </p>
                {member.blurb ? <p className="text-sm text-secondary">{member.blurb}</p> : null}
              </li>
            ))}
          </ul>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="memory">
        <AccordionTrigger>记忆</AccordionTrigger>
        <AccordionContent>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
            {state.memory || "（空）"}
          </pre>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="player">
        <AccordionTrigger>玩家</AccordionTrigger>
        <AccordionContent>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{state.player || "（空）"}</pre>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
