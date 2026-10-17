# Organisation structure of the Library Journal Club society

Diagrams for recommendations §4 of [organisation_structure.md](organisation_structure.md) and §1-2 of [synthesis.md](synthesis.md). First the whole organisation, then each step as an interaction, then three full cycles showing what changes between rounds. Each element names the paper it comes from.

## 🏛️ The whole organisation

```mermaid
flowchart TB
    accTitle: Library Journal Club organisation structure
    accDescr: Twenty paper agents sit on a flat network. Two shared stores, a registry and an archive, mediate who finds whom. Three privileged roles that do no research: reviewers drawn from the agents, a judge on a different model, and a meta-reviewer. The human sets the agenda and triages unresolved disputes. Everything is written to one event log that feeds Zotero, the network view and the minutes.

    human["🧑‍🔬 Scientist<br/>agenda at start, morning triage<br/>(Virtual Lab: ~1% of words)"]

    subgraph society["Flat society of paper agents (ASCollab: every agent is a PI)"]
        direction LR
        paper_a["📄 Paper A"]
        paper_b["📄 Paper B"]
        paper_c["📄 Paper C"]
        paper_n["📄 ... Paper T<br/>(20 total)"]
        paper_a <-. "sparse random edges<br/>~3 per agent (MacNet)" .-> paper_b
        paper_b <-.-> paper_c
        paper_a <-. "1 long-range edge between<br/>most divergent claims (small-world)" .-> paper_n
    end

    subgraph stores["Shared stores (ASCollab §3.1)"]
        registry[("🗂️ Registry<br/>expertise embedding<br/>#accepted, #citations")]
        archive[("📚 Archive<br/>never discard (DGM)<br/>notes + scores + verdicts")]
    end

    subgraph privileged["Roles that do no research"]
        reviewers["🔍 Reviewers<br/>2 near + 1 far, blind<br/>(AgentReview, ResearchTown)"]
        judge["⚖️ Judge<br/>different model from debaters<br/>(Liang MAD)"]
        meta["📝 Meta-reviewer<br/>tournament of 4, digest<br/>(ASCollab, Co-Scientist)"]
    end

    events[["🧾 events.jsonl<br/>append-only"]]

    subgraph outputs["What the scientist sees"]
        zotero["📓 Zotero notes"]
        network["🕸️ Network view<br/>green = collab, red = dispute"]
        minutes["📰 Minutes"]
    end

    human -- "agenda, claims" --> society
    society -- "find collaborator / reviewer<br/>0.8 sim + 0.2 citations" --> registry
    society -- "retrieve top-k prior findings" --> archive
    society -- "notes, not transcripts" --> reviewers
    reviewers -- "scores 1-4 x4, rec 1-5" --> meta
    society -- "clashing claims" --> judge
    judge -- "stands / contested / unresolved" --> events
    meta -- "accept top 25-50%" --> archive
    meta -- "why things lost" --> society
    archive -- "citations update reputation" --> registry
    reviewers --> events
    meta --> events
    society --> events
    events --> zotero
    events --> network
    events --> minutes
    events -- "unresolved only" --> human

    classDef agent fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a5f
    classDef store fill:#fef9c3,stroke:#ca8a04,stroke-width:2px,color:#713f12
    classDef role fill:#fce7f3,stroke:#db2777,stroke-width:2px,color:#831843
    classDef log fill:#e5e7eb,stroke:#4b5563,stroke-width:2px,color:#1f2937
    classDef out fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d
    classDef person fill:#ffedd5,stroke:#ea580c,stroke-width:2px,color:#7c2d12

    class paper_a,paper_b,paper_c,paper_n agent
    class registry,archive store
    class reviewers,judge,meta role
    class events log
    class zotero,network,minutes out
    class human person
```

Structural decisions, with their source:

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Hierarchy | Flat; no PI agent | Papers are peers; a PI would average dissent away | ASCollab §3 |
| Who may talk to whom | Sparse random edges, ~3 per agent, plus one long-range edge | Random DAGs beat mesh at half the time; ~16 nodes is the useful range | MacNet, small-world |
| What travels on an edge | Structured notes only, never transcripts | Linear context growth; models attend to latest turns anyway | MacNet, ChatDev, Virtual Lab, Du et al. |
| Reviewers | Drawn from the agents, 2 near + 1 far, blind | Author identity shifts decisions 27.7% | AgentReview, ResearchTown |
| Judge | Separate role on a different model | Judge favours its own backbone | Liang MAD |
| Meta-reviewer | Tool-less, sees 4 related notes + archive samples | Calibration against the archive | ASCollab §3.4 |
| Human | Agenda at start, triage of `unresolved` in the morning | Cheap and high-leverage at checkpoints | Virtual Lab, AutoGen, Agent Laboratory |

---

## 🔁 One round, step by step

Each step is one interaction pattern. Actors are the same as in the organisation diagram.

### Step 1: Paper agents wake up

```mermaid
sequenceDiagram
    accTitle: Step 1 paper agent creation and warm-up
    accDescr: Person 1 produces a paper card per Zotero item. Each agent is built from four fields plus a six-stance persona. Before acting, every agent reads its own digest and the archive.

    participant Z as Zotero
    participant P1 as Person 1 ingestion
    participant A as Paper agent
    participant AR as Archive
    participant M as Meta-reviewer

    Z->>P1: metadata + PDF
    P1->>A: paper_card (claims, methods, data, limits, tools)
    Note over A: title, expertise, goal, role (Virtual Lab)<br/>+ 6 fixed stances (ASCollab B.2)
    M-->>A: digest: why things lost last round, own lowest score
    A->>AR: top-k similar findings (0.2 citation boost)
    AR-->>A: prior notes
```

Round 1 has no digest and an empty archive; the dashed arrows are skipped.

### Step 2: Peer review

```mermaid
sequenceDiagram
    accTitle: Step 2 blind peer review with reviewer matching
    accDescr: For each paper note, the registry returns two near reviewers by embedding similarity and one far reviewer from another cluster. Reviewers score on a fixed rubric without seeing authorship. Scores go to the event log and the meta-reviewer.

    participant A as Paper A (author)
    participant R as Registry
    participant N1 as Near reviewer 1
    participant N2 as Near reviewer 2
    participant F as Far reviewer
    participant E as events.jsonl

    A->>R: note embedding
    R-->>A: top-2 similar (ResearchTown), 1 random other cluster (MacNet)
    par blind, in parallel
        A->>N1: note with authorship stripped
        A->>N2: note with authorship stripped
        A->>F: note with authorship stripped
    end
    N1-->>E: Support/Soundness/Significance/Originality 1-4, rec 1-5
    N2-->>E: same rubric
    F-->>E: same rubric
    Note over N1,F: cap 3 reviews per agent per round<br/>reject reviews under a length floor (AgentReview)
```

### Step 3: Dispute

```mermaid
sequenceDiagram
    accTitle: Step 3 dispute with a neutral judge
    accDescr: A dispute opens when structured claims clash or two reviewers differ by two or more. The owner and challenger argue for at most three turns with moderate intensity. A judge on a different model rules after each turn and extracts a verdict at the cap.

    participant E as events.jsonl
    participant O as Paper A (owner)
    participant C as Paper B (challenger)
    participant J as Judge (other model)
    participant H as Scientist

    E->>J: trigger: claims clash, or reviewer recs differ by >= 2
    loop up to 3 turns (Liang MAD, Du saturation)
        O->>J: defend with quotes + locations
        C->>J: counter with quotes + locations
        J->>J: discriminative check: resolved yet?
    end
    alt judge sides with owner
        J-->>E: stands
    else judge sides with challenger
        J-->>E: contested (both claims kept, linked)
    else cap hit, no verdict
        J-->>E: unresolved
        E-->>H: morning triage
    end
    Note over O,C: no permanent devil's advocate (Smit)<br/>"no conflict" is a legal outcome
```

### Step 4: Collaboration

```mermaid
sequenceDiagram
    accTitle: Step 4 pair collaboration
    accDescr: Pairs are chosen by proximity, one near pair for depth and one cross-cluster pair for breadth. The initiator leads and the collaborator critiques and asks clarifying questions but cannot run tools. The output is one joint note with a novelty check against the archive.

    participant R as Registry
    participant I as Paper C (initiator)
    participant K as Paper D (collaborator)
    participant AR as Archive
    participant E as events.jsonl

    R-->>I: near pair or cross-cluster pair (Co-Scientist Proximity)
    I->>K: establish_collaboration (ASCollab)
    K->>I: clarifying questions first (ChatDev dehallucination)
    I->>K: proposal: C's method on D's data could test X
    K-->>I: critique, cannot run tools
    I->>AR: novelty check (kNN distance, AgentRxiv dedup)
    alt novel
        I->>E: joint note, parents C and D, edge green
    else overlaps archive
        I->>E: dropped, reason logged
    end
```

### Step 5: Meta-review and archive

```mermaid
sequenceDiagram
    accTitle: Step 5 meta-review tournament and archive write-back
    accDescr: Notes are clustered into tournaments of four. The meta-reviewer sees reviews, verdicts and random archive samples, then ranks strictly. The top fraction passes the gate, enters the archive and is written back to Zotero. The meta-reviewer also writes the digest for the next round.

    participant E as events.jsonl
    participant M as Meta-reviewer
    participant AR as Archive
    participant RG as Registry
    participant Z as Zotero

    E->>M: reviews + verdicts, clustered into tournaments of 4 (ASCollab L=4)
    AR-->>M: random samples for calibration
    M->>M: score 0-1, strict rank, no ties
    M->>E: accept top 25-50%
    Note over M,AR: gate: quotes string-match source,<br/>>= 2 uninvolved reviewers accept,<br/>rubric >= threshold
    E->>AR: accepted notes, tagged verified / unverified (AgentRxiv)
    AR->>RG: citations update #accepted, #citations
    E->>Z: note on each paper involved
    M-->>E: digest for next round (Co-Scientist meta-review)
```

---

## 🌙 Three cycles overnight

The same five steps run three times. What differs is the state each round starts from. The cycle count is capped at 3-4 because LLM-judged loops flatten after about four rounds (Du et al.) and compounding is only documented with an external evaluator ([rsi.md](rsi.md) §c).

```mermaid
flowchart LR
    accTitle: Three cycles and what carries between them
    accDescr: Round one starts cold with an empty archive and no digest. Round two starts with the archive, the first digest and updated reputation. Round three adds Elo-prioritised review and unresolved disputes carried forward. After round three the scientist triages in the morning.

    agenda["🧑‍🔬 Agenda<br/>Friday 10 pm"]
    r1["🔵 Round 1<br/>cold start<br/>empty archive, no digest<br/>random reviewer load"]
    r2["🟢 Round 2<br/>warm<br/>archive seeded, digest #1<br/>reputation updated"]
    r3["🟣 Round 3<br/>focused<br/>Elo picks what to review first<br/>unresolved carried forward"]
    triage["☀️ Morning triage<br/>unresolved to scientist<br/>minutes + network view"]

    agenda --> r1
    r1 -- "archive, digest #1,<br/>registry stats" --> r2
    r2 -- "archive, digest #2,<br/>Elo from dispute outcomes" --> r3
    r3 --> triage

    classDef cold fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#1e3a5f
    classDef warm fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d
    classDef focus fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#4c1d95
    classDef person fill:#ffedd5,stroke:#ea580c,stroke-width:2px,color:#7c2d12

    class r1 cold
    class r2 warm
    class r3 focus
    class agenda,triage person
```

### Cycle 1: cold start

Worked example with five papers from a 20-paper library: A, B (large cohort, same question as A), C (method paper), D (dataset paper), E (unrelated cluster).

```mermaid
sequenceDiagram
    accTitle: Cycle 1 cold start
    accDescr: Round one. Agents are created from paper cards. Reviewers are matched by similarity only, since no reputation exists. Paper B questions Paper A's effect size, opening the first dispute, which the judge rules contested. C and D form the first collaboration. The archive receives its first accepted notes and the meta-reviewer writes the first digest.

    participant H as Scientist
    participant S as Society (A..T)
    participant RG as Registry
    participant RV as Reviewers
    participant J as Judge
    participant M as Meta-reviewer
    participant AR as Archive

    H->>S: agenda: "Is X a good target?"
    Note over S: 20 agents built from paper cards<br/>no digest, no archive
    S->>RG: register expertise embeddings (all #citations = 0)
    S->>RV: 20 notes, 60 reviews (similarity only)
    RV->>M: scores
    Note over RV: B (larger cohort) questions A's effect size
    RV->>J: A vs B: recs differ by 2
    J->>J: 3 turns, A defends, B counters
    J-->>AR: contested: A's claim kept, B's counter linked
    S->>S: C + D: "C's method on D's data could test X"
    S->>AR: joint note C+D (novel: archive empty)
    M->>AR: accept top 25%: 5 notes incl. C+D
    AR->>RG: C, D gain #accepted; B gains citation from A's note
    M-->>S: digest #1: "effect sizes without cohort size lost"
```

Events written: 60 reviews, 1 dispute (red edge A-B), 1 collaboration (green edge C-D), 5 findings.

### Cycle 2: warm

```mermaid
sequenceDiagram
    accTitle: Cycle 2 warm start
    accDescr: Round two. Every agent reads digest one and retrieves archive hits before acting. Reviewer matching now weights reputation, so C and D are found more often. Paper E, from a distant cluster, is pulled in as a far reviewer and challenges the C plus D note. The judge rules that it stands. A revises its claim in light of the contested verdict. The archive grows and the digest is updated.

    participant S as Society (A..T)
    participant RG as Registry
    participant AR as Archive
    participant RV as Reviewers
    participant J as Judge
    participant M as Meta-reviewer
    participant E as events.jsonl

    M-->>S: digest #1 + each agent's lowest score (ASCollab exp 04)
    S->>AR: retrieve top-k (0.2 citation boost)
    AR-->>S: round-1 accepted notes
    Note over S: A re-states claim with cohort size<br/>(non-greedy: not every agent revisits, DGM few-children bonus)
    S->>RG: find reviewers: 0.8 sim + 0.2 citations
    RG-->>S: C and D now ranked higher
    S->>RV: 20 notes, 60 reviews; E drawn as far reviewer for C+D
    RV->>J: E vs C+D: E scores Soundness 1
    J->>J: 3 turns, different model
    J-->>E: stands: E's objection does not apply to D's data
    S->>S: A + B pair: joint note reconciling effect sizes (near pair)
    S->>S: C + E pair: cross-cluster, dropped (vague, ResearchTown)
    M->>AR: accept top 25%: A+B joint note, A revised, 3 others
    AR->>RG: reputation: A, B, C, D up
    M-->>S: digest #2: "cross-cluster proposals lost on specificity"
```

Events written: 60 reviews, 1 dispute (stands), 2 collaborations (1 accepted, 1 dropped), 5 findings. Red edge A-B from round 1 now has a green edge beside it.

### Cycle 3: focused

```mermaid
sequenceDiagram
    accTitle: Cycle 3 focused round
    accDescr: Round three. Elo computed from dispute outcomes decides which notes are reviewed first. The long-range edge is rewired to the two most divergent agents. A new dispute between D and a late paper hits the turn cap without a verdict and is marked unresolved for the scientist. The round ends with Zotero write-back and the minutes.

    participant S as Society (A..T)
    participant RG as Registry
    participant RV as Reviewers
    participant J as Judge
    participant M as Meta-reviewer
    participant AR as Archive
    participant Z as Zotero
    participant H as Scientist

    M-->>S: digest #2, Elo ranking of claims
    Note over S: long-range edge rewired: D <-> P<br/>(most divergent claims, small-world)
    S->>RV: Elo-ordered: contested and high-Elo notes reviewed first
    RV->>J: D vs P: P claims D's dataset has batch effects
    J->>J: 3 turns, no discriminative verdict
    J-->>AR: unresolved
    S->>S: B + C pair: B's cohort with C's method
    M->>AR: accept top 25%: B+C note, 4 others
    Note over M,AR: gate: all quotes string-matched, >= 2 uninvolved accept
    AR->>Z: notes on A, B, C, D, P: findings, verdicts, citations
    AR->>H: minutes: "3 rounds, 3 disputes (1 stands, 1 contested, 1 unresolved),<br/>4 collaborations proposed, 15 findings passed"
    AR->>H: unresolved D vs P for triage
    Note over H: no "rounds got better" claim without an external check<br/>(citation string-match pass rate per round is the cheap one)
```

### What changes between cycles

| State | Cycle 1 | Cycle 2 | Cycle 3 |
| --- | --- | --- | --- |
| Archive | Empty | Round-1 accepted notes | Rounds 1-2 |
| Digest to agents | None | #1: why things lost | #2 + Elo ranking |
| Reviewer matching | Similarity only | 0.8 sim + 0.2 citations | Same, Elo decides review order |
| Long-range edge | Random | Random | Rewired to most divergent pair |
| Disputes | Opened by clashing claims | Also by reviewer disagreement | Unresolved carried to human |
| Collaboration pairs | Near pairs | Near + one cross-cluster | Pairs that won disputes |
| Zotero | Nothing | Nothing | Write-back of all passed findings |
| Checkpoint | After every step | After every step | After every step, then stop |

Budget per cycle, ~20 papers: 20 sessions + 60 reviews + ~3 disputes × 3 turns × 3 agents + ~3 collaborations + 5 meta-reviews, roughly 130-150 LLM calls. Three cycles ≈ 450 calls. Measure cycle 1 before 10 pm and extrapolate; no source paper reports a dollar figure.

---

## Sources

Every element above is traced in the track files: [ascollab.md](ascollab.md) (flat society, registry, archive, K=2 blind review, tournament meta-review, no dispute mechanism), [virtual_lab.md](virtual_lab.md) (four-field agents, standing critic, structured summaries, human share of words), [organisation_structure.md](organisation_structure.md) (MacNet topology, small-world rewiring, AgentReview blinding and numeric scores, ResearchTown reviewer matching, Liang MAD judge, Smit devil's-advocate result, ChatDev dehallucination, Co-Scientist proximity and meta-review, AgentRxiv verification tags), [rsi.md](rsi.md) (DGM never-discard archive and non-greedy selection, Du et al. four-round saturation, ASCollab exp 04 self-reflection, the external-evaluator caveat).
