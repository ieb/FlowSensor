# 2 NTC sensor

In AnalysisPrompt.md and model-explorer I looked at the single NTC probe heated by a self regulating 80C ceramic PTC. It gave strong differentiation over air, still water, flowing water, but was not so accurate at measuring flow due to the small temperature differences.

Here I want to try a differnt approach, using 2 NTCs. The upstream one senses the stream temperature. The downstream one is heated by increasing the current to maintain a constant temperature difference of say 10C at the NTC. An diffential op amp is used to drive the voltage to the downstream NTC. The intuition is that by driving the temperature difference is proportional to the flow, and the temperature is proportional to the rate of power input.

The sensors could be in 316 tubes (5mm, no head, 3mm hole, 1mm wall thickness) or the  50% of the glass beads exposed to the fluid while encapsulating the parts that are sensitive to salt water.