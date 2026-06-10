# Modelling the Sensor

# Prompt 

I want to build a model for the sensor that represents its behaviour in the following conditions.

* Sensor in Air, infinite mass
* Sensor in still sea water, infinite mass
* Sensor in flowing sea water


The sensor is the shape of a M6 screw with a round head. It has a 30mm shaft with a 3mm hold in the shaft. The head is 9.2mm diameter by 3.4mm thick. The NTC is inside the axial center of the head 2mm from the end surface. The PTC is connected to the shaft 22mm from the end surface. The sensor shaft is embeeded in PTFE which can be assumed to condict no heat. The PTC is max 6W and maintains a constant 80C temperature embedded into an aluminium casing. Onlt the head of the sensor is exposed to the fluid.


# Analysis

The analyis should provide an insight into the temperature and readings in a number of senarios which will be used to detect air, water and flow rates. Simplified models of those scenarios are below.

# Sensor in Static Air or Water

```
PTC 80C constant temperature ---> 6mm OD, 3mm ID lenth 21mm 316 stainless ---> Cylinder OD 9.2mm height 3.4mm --> infinite sink

``` 

# Sensor in Flowing Water

```
PTC 80C constant temperature ---> 6mm OD, 3mm ID lenth 21mm 316 stainless ---> Cylinder OD 9.2mm height 3.4mm --> flowing water at known temperature eg 20C

``` 

# Turn on Static Air or Water

```
3W 20x5x40mm aliuminium ---> 6mm OD, 3mm ID lenth 21mm 316 stainless ---> Cylinder OD 9.2mm height 3.4mm --> infinite sink

``` 

# Turn on heater in Flowing Water

```
3W 20x5x40mm aliuminium ---> 6mm OD, 3mm ID lenth 21mm 316 stainless ---> Cylinder OD 9.2mm height 3.4mm --> flowing water at starting temperature

``` 


claude --resume 60b61d93-0cd1-4a93-9194-a62aa4208412                      

